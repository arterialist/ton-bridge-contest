import "@stdlib/tvm-dicts"

tolk 0.6

const OP_NEW_KEY_BLOCK = 0x11a78ffe;
const OP_CHECK_BLOCK = 0x8eaa9d76;

fun parseValidator(validator: slice) {
    var validatorType = validator.loadUint(8); 
    validator.loadUint(32); // skip public key prefix
    var validatorPublicKey = validator.loadUint(256);
    var validatorWeight = validator.loadUint(64);
    var nodeIdRaw = beginCell().storeUint(0xc6, 8).storeUint(0xb4, 8).storeUint(0x13, 8).storeUint(0x48, 8).storeUint(validatorPublicKey, 256).endCell();
    var nodeId = stringHash(nodeIdRaw.beginParse());
    return (nodeId, validatorPublicKey, validatorWeight);
}

fun isBlockSignatureValid(blockHash: int, validatorsDict: cell, maxMain: int, signatures: cell) {
    var signaturesSlice = signatures.beginParse();
    var blockFileHash = signaturesSlice.loadUint(256);
    var signaturesDict = signaturesSlice.loadDict();
    if (signaturesDict == null) { throw 0x00003001; }

    var message = beginCell().storeUint(0x70, 8).storeUint(0x6e, 8).storeUint(0x0b, 8).storeUint(0xc5, 8).storeUint(blockHash, 256).storeUint(blockFileHash, 256).endCell().beginParse();
    var signedWeight = 0;
    var validatorsDictByWeight = createEmptyDict();
    var (key, validator, found) = validatorsDict.uDictGetFirst(16);
    do {
            (key, validator, found) = validatorsDict.uDictGetNext(16, key);
        if (found == -1) {           
            var (nodeId, validatorPublicKey, validatorWeight) = parseValidator(validator);
            validatorsDictByWeight.uDictSet(64, validatorWeight, beginCell().storeUint(nodeId, 256).endCell().beginParse());
            var (signatureValue, signatureFound) = signaturesDict.uDictGet(256, nodeId);
            if (signatureFound == -1) {
                var isValid = isSliceSignatureValid(message, signatureValue, validatorPublicKey);
                if (isValid == 0) { throw 0x00003002; }
                signedWeight += validatorWeight;
            }
        }
    } while (found != 0);

    // count total weight of maxMain number of validators in validatorsDictByWeight
    var totalWeight = 0;
    var validatorsCount = 0;
    var (valWeight, valNodeId, valFound) = validatorsDictByWeight.uDictGetFirst(64);
    do {
            (valWeight, valNodeId, valFound) = validatorsDictByWeight.uDictGetNext(64, valWeight);
        totalWeight += valWeight;
        validatorsCount += 1;
    } while (validatorsCount < maxMain);

    return signedWeight * 3 > totalWeight * 2 ? -1 : 0;
}

fun processNewKeyBlock(queryId: int, block: cell, signatures: cell, senderAddress: slice) {
    var blockSlice: slice = block.beginParse();
    blockSlice.loadUint(32); //skip magic prefix
    blockSlice.loadInt(32); //skip global_id
    
    var blockInfo = blockSlice.loadRef();
    if (blockInfo == null) { throw 0x00001001; }

    // start searching for the key block flag

    var blockInfoSlice: slice = blockInfo.beginParse();
    blockInfoSlice.loadUint(32); // skip magic prefix
    blockInfoSlice.loadUint(32); // skip version
    blockInfoSlice.loadBits(6); // skip not_master, after_merge, before_split, after_split, want_split, want_merge

    var isKeyBlock = blockInfoSlice.loadBool();
    if (!isKeyBlock) { throw 0x00001002; }

    blockInfoSlice.loadUint(1); // skip vertSeqnoIncr
    blockInfoSlice.loadUint(8); // skip flags
    var seqno = blockInfoSlice.loadUint(32); // skip seqNo
    blockInfoSlice.loadUint(32); // skip vertSeqNo
    blockInfoSlice.loadUint(2); // skip shardIdent
    blockInfoSlice.loadUint(6); // skip shardPrefixBits
    blockInfoSlice.loadInt(32); // skip workchainId
    blockInfoSlice.loadUint(64); // skip shardId
    var genUtime = blockInfoSlice.loadUint(32);

    blockSlice.loadRef(); // skip value_flow
    blockSlice.loadRef(); // skip state_update

    var extra = blockSlice.loadRef();
    if (extra == null) { throw 0x00001003; }
    var extraSlice: slice = extra.beginParse();

    // start searching for the masterchain block extra

    extraSlice.loadUint(32); // skip magic prefix
    extraSlice.loadRef(); // skip in_msg_descr
    extraSlice.loadRef(); // skip out_msg_descr
    extraSlice.loadRef(); // skip account_blocks
    extraSlice.loadBits(256); // skip rand_seed
    extraSlice.loadBits(256); // skip created_by

    var mcBlockExtra = extraSlice.loadMaybeRef();
    if (mcBlockExtra == null) { throw 0x00001004; }
    var mcBlockExtraSlice: slice = mcBlockExtra.beginParse();

    mcBlockExtraSlice.loadUint(16); // skip magic prefix

    var isMcKeyBlock = mcBlockExtraSlice.loadBool();
    if (isMcKeyBlock == 0) { throw 0x00001005; }

    mcBlockExtraSlice.loadDict(); // skip shard_hashes
    mcBlockExtraSlice.loadDict(); // skip shard_fees
    mcBlockExtraSlice.loadDict(); // skip prev_blk_signatures
    mcBlockExtraSlice.loadMaybeRef(); // skip recover_create_msg
    mcBlockExtraSlice.loadMaybeRef(); // skip mint_msg
    mcBlockExtraSlice.loadBits(256); // skip config_addr

    var config = mcBlockExtraSlice.loadRef();
    var (currentValidatorsRaw, currentFound) = config.uDictGet(32, 0x22);
    if (currentFound == 0) { throw 0x00001006; }

    var currentValidators = currentValidatorsRaw.loadRef();
    var currentValidatorsHash = currentValidators.cellHash();

    var data = getContractData().beginParse();
    var validatorsHash = data.loadUint(256);
    var storedSeqno = data.loadUint(32);
    if (
        validatorsHash != currentValidatorsHash ||
        seqno < storedSeqno
    ) { throw 0x00001007; }
    
    var (prevValidatorsRaw, prevFound) = config.uDictGet(32, 0x20);
    if (prevFound == 0) { throw 0x00001008; }

    var prevValidators = prevValidatorsRaw.loadRef().beginParse();
    var prevValidatorsType = prevValidators.loadUint(8);
    prevValidators.loadUint(32); // skip utimeSince
    var prevUtimeUntil = prevValidators.loadUint(32);

    if (genUtime < (prevUtimeUntil + 5000)) {
        prevValidators.loadUint(16); // skip total
        var prevMaxMain = prevValidators.loadUint(16);
        if (prevValidatorsType == 18) { var totalWeight = prevValidators.loadUint(64); }
        var validators = prevValidators.loadDict();
        if (isBlockSignatureValid(block.cellHash(), validators, prevMaxMain, signatures) == 0) { throw 0x00001009; }
    } else {
        var currentValidatorsValue = currentValidators.beginParse();
        var currentValidatorsType = currentValidatorsValue.loadUint(8);
        currentValidatorsValue.loadUint(32); // skip utimeSince
        currentValidatorsValue.loadUint(32); // skip utimeUntil
        currentValidatorsValue.loadUint(16); // skip total
        var currentMaxMain = currentValidatorsValue.loadUint(16);
        if (currentValidatorsType == 18) { var totalWeight = currentValidatorsValue.loadUint(64); }
        var validators = currentValidatorsValue.loadDict();
        if (isBlockSignatureValid(block.cellHash(), validators, currentMaxMain, signatures) == 0) { throw 0x00001009; }
    }

    setContractData(beginCell().storeUint(currentValidatorsHash, 256).storeUint(seqno, 32).endCell());
    sendRawMessage(
        beginCell()
            .storeUint(0x18, 6)
            .storeSlice(senderAddress)
            .storeCoins(0)
            .storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
            .storeUint(0xff8ff4e1, 32)
            .storeUint(queryId, 64)
            .storeUint(block.cellHash(), 256)
        .endCell(),
        SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE
    );
}

fun processCheckBlock(queryId: int, block: cell, signatures: cell, senderAddress: slice) {
    var blockSlice: slice = block.beginParse();
    blockSlice.loadUint(32); //skip magic prefix
    blockSlice.loadInt(32); //skip global_id
    
    var blockInfo = blockSlice.loadRef();
    if (blockInfo == null) { throw 0x00002001; }

    var blockInfoSlice: slice = blockInfo.beginParse();
    blockInfoSlice.loadUint(32); // skip magic prefix
    blockInfoSlice.loadUint(32); // skip version
    blockInfoSlice.loadBits(6); // skip not_master, after_merge, before_split, after_split, want_split, want_merge
    blockInfoSlice.loadBool(); // skip key_block
    blockInfoSlice.loadUint(1); // skip vertSeqnoIncr
    blockInfoSlice.loadUint(8); // skip flags
    var seqno = blockInfoSlice.loadUint(32);
    blockInfoSlice.loadUint(32); // skip vertSeqNo
    blockInfoSlice.loadUint(2); // skip shardIdent
    blockInfoSlice.loadUint(6); // skip shardPrefixBits
    blockInfoSlice.loadInt(32); // skip workchainId
    blockInfoSlice.loadUint(64); // skip shardId
    var genUtime = blockInfoSlice.loadUint(32);

    blockSlice.loadRef(); // skip value_flow
    blockSlice.loadRef(); // skip state_update
    var extra = blockSlice.loadRef();
    if (extra == null) { throw 0x00002002; }
    var extraSlice: slice = extra.beginParse();

    // start searching for the masterchain block extra

    extraSlice.loadUint(32); // skip magic prefix
    extraSlice.loadRef(); // skip in_msg_descr
    extraSlice.loadRef(); // skip out_msg_descr
    extraSlice.loadRef(); // skip account_blocks
    extraSlice.loadBits(256); // skip rand_seed
    extraSlice.loadBits(256); // skip created_by

    var mcBlockExtra = extraSlice.loadMaybeRef();
    if (mcBlockExtra == null) { throw 0x00002003; }
    var mcBlockExtraSlice: slice = mcBlockExtra.beginParse();

    mcBlockExtraSlice.loadUint(16); // skip magic prefix
    mcBlockExtraSlice.loadBool(); // skip key_block
    mcBlockExtraSlice.loadDict(); // skip shard_hashes
    mcBlockExtraSlice.loadDict(); // skip shard_fees
    mcBlockExtraSlice.loadDict(); // skip prev_blk_signatures
    mcBlockExtraSlice.loadMaybeRef(); // skip recover_create_msg
    mcBlockExtraSlice.loadMaybeRef(); // skip mint_msg
    mcBlockExtraSlice.loadBits(256); // skip config_addr

    var config = mcBlockExtraSlice.loadRef();
    var (currentValidatorsRaw, currentFound) = config.uDictGet(32, 0x22);
    if (currentFound == 0) { throw 0x00002004; }

    var currentValidators = currentValidatorsRaw.loadRef();
    var currentValidatorsHash = currentValidators.cellHash();

    var data = getContractData().beginParse();
    var validatorsHash = data.loadUint(256);
    if (validatorsHash != currentValidatorsHash) { throw 0x00002005; }

    var (prevValidatorsRaw, prevFound) = config.uDictGet(32, 0x20);
    if (prevFound == 0) { throw 0x00002006; }

    var prevValidators = prevValidatorsRaw.loadRef().beginParse();
    var prevValidatorsType = prevValidators.loadUint(8);
    prevValidators.loadUint(32); // skip utimeSince
    var prevUtimeUntil = prevValidators.loadUint(32);

    if (genUtime < (prevUtimeUntil + 5000)) {
        prevValidators.loadUint(16); // skip total
        var prevMaxMain = prevValidators.loadUint(16);
        if (prevValidatorsType == 18) { var totalWeight = prevValidators.loadUint(64); }
        var validators = prevValidators.loadDict();
        if (isBlockSignatureValid(block.cellHash(), validators, prevMaxMain, signatures) == 0) { throw 0x00002007; }
    } else {
        var currentValidatorsValue = currentValidators.beginParse();
        var currentValidatorsType = currentValidatorsValue.loadUint(8);
        currentValidatorsValue.loadUint(32); // skip utimeSince
        currentValidatorsValue.loadUint(32); // skip utimeUntil
        currentValidatorsValue.loadUint(16); // skip total
        var currentMaxMain = currentValidatorsValue.loadUint(16);
        if (currentValidatorsType == 18) { var totalWeight = currentValidatorsValue.loadUint(64); }
        var validators = currentValidatorsValue.loadDict();
        if (isBlockSignatureValid(block.cellHash(), validators, currentMaxMain, signatures) == 0) { throw 0x00002007; }
    }

    sendRawMessage(
        beginCell()
            .storeUint(0x18, 6)
            .storeSlice(senderAddress)
            .storeCoins(0)
            .storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
            .storeUint(0xce02b807, 32)
            .storeUint(queryId, 64)
            .storeUint(block.cellHash(), 256)
        .endCell(),
        SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE
    );
}

fun onInternalMessage(myBalance: int, msgValue: int, msgFull: cell, msgBody: slice) {
    if (msgBody.isEndOfSlice()) { return; }

    var msgFullSlice = msgFull.beginParse();
    msgFullSlice.loadMessageFlags(); // skip flags
    var senderAddress = msgFullSlice.loadAddress();

    var op = msgBody.loadMessageOp();
    if (op != OP_NEW_KEY_BLOCK && op != OP_CHECK_BLOCK) { throw 0xffff; }

    var queryId = msgBody.loadMessageQueryId();
    var block: cell = msgBody.loadRef();
    var signatures: cell = msgBody.loadRef();

    if (op == OP_NEW_KEY_BLOCK) {
        processNewKeyBlock(queryId, block, signatures, senderAddress);
    } else if (op == OP_CHECK_BLOCK) {
        processCheckBlock(queryId, block, signatures, senderAddress);
    }
}
