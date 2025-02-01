import "@stdlib/tvm-dicts"

tolk 0.6

const OP_NEW_KEY_BLOCK = 0x11a78ffe;
const OP_CHECK_BLOCK = 0x8eaa9d76;

fun isEpochValid(validatorsHash: int) {
    var data = getContractData().beginParse();
    return data.loadUint(256) == validatorsHash;
}

fun parseValidator(validator: slice) {
    var validatorType = validator.loadUint(8); 
    validator.loadUint(32); // skip public key prefix
    var validatorPublicKey = validator.loadUint(256);
    var validatorWeight = validator.loadUint(64);
    var nodeIdRaw = beginCell().storeUint(0xc6, 8).storeUint(0xb4, 8).storeUint(0x13, 8).storeUint(0x48, 8).storeUint(validatorPublicKey, 256).endCell();
    var nodeId = stringHash(nodeIdRaw.beginParse());
    return (nodeId, validatorPublicKey, validatorWeight);
}

fun isBlockSignatureValid(blockHash: int, validatorsDict: cell, signatures: cell) {
    var signaturesSlice = signatures.beginParse();
    var blockFileHash = signaturesSlice.loadUint(256);
    var signaturesDict = signaturesSlice.loadDict();
    if (signaturesDict == null) { throw 0x00003001; }

    var message = beginCell().storeUint(0x70, 8).storeUint(0x6e, 8).storeUint(0x0b, 8).storeUint(0xc5, 8).storeUint(blockHash, 256).storeUint(blockFileHash, 256).endCell().beginParse();
    var totalWeight = 0;
    var signedWeight = 0;
    var (key, validator, found) = validatorsDict.uDictGetFirst(16);
    do {
            (key, validator, found) = validatorsDict.uDictGetNext(16, key);
        if (found == -1) {            
            var (nodeId, validatorPublicKey, validatorWeight) = parseValidator(validator);
            totalWeight += validatorWeight;
            var (signatureValue, signatureFound) = signaturesDict.uDictGet(256, nodeId);
            if (signatureFound == -1) {
                var isValid = isSliceSignatureValid(message, signatureValue, validatorPublicKey);
                if (isValid == 0) { throw 0x00003002; }
                signedWeight += validatorWeight;
            }
        }
    } while (found != 0);

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

    // get config param 0x20
    var (blockValidatorsRaw, found) = config.uDictGet(32, 0x20);
    if (found == 0) { throw 0x00001006; }

    var blockValidators = blockValidatorsRaw.loadRef();
    var blockValidatorsHash = blockValidators.cellHash();

    if (!isEpochValid(blockValidatorsHash)) { throw 0x00001007; }

    var blockValidatorsValue = blockValidators.beginParse();
    var blockValidatorsType = blockValidatorsValue.loadUint(8);
    var utimeSince = blockValidatorsValue.loadUint(32);
    var utimeUntil = blockValidatorsValue.loadUint(32);
    var total = blockValidatorsValue.loadUint(16);
    var main = blockValidatorsValue.loadUint(16);

    if (blockValidatorsType == 18) {
        var totalWeight = blockValidatorsValue.loadUint(64);
    }

    var validators = blockValidatorsValue.loadDict();
    if (validators == null) { throw 0x00001008; }

    if (isBlockSignatureValid(block.cellHash(), validators, signatures) == 0) { throw 0x00001009; }

    setContractData(beginCell().storeUint(blockValidatorsHash, 256).endCell());
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

    // get config param 0x20
    var (blockValidatorsRaw, found) = config.uDictGet(32, 0x20);
    if (found == 0) { throw 0x00002004; }

    var blockValidators = blockValidatorsRaw.loadRef();
    var blockValidatorsHash = blockValidators.cellHash();

    if (!isEpochValid(blockValidatorsHash)) { throw 0x00002005; }

    var blockValidatorsValue = blockValidators.beginParse();
    var blockValidatorsType = blockValidatorsValue.loadUint(8);
    var utimeSince = blockValidatorsValue.loadUint(32);
    var utimeUntil = blockValidatorsValue.loadUint(32);
    var total = blockValidatorsValue.loadUint(16);
    var main = blockValidatorsValue.loadUint(16);

    if (blockValidatorsType == 18) {
        var totalWeight = blockValidatorsValue.loadUint(64);
    }

    var validators = blockValidatorsValue.loadDict();
    if (validators == null) { throw 0x00002006; }

    if (isBlockSignatureValid(block.cellHash(), validators, signatures) == 0) { throw 0x00002007; }

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
    msgFullSlice.loadUint(4); // skip flags
    var senderAddress = msgFullSlice.loadAddress();

    var op = msgBody.loadUint(32);
    if (op != OP_NEW_KEY_BLOCK && op != OP_CHECK_BLOCK) { throw 0x11111111; }

    var queryId = msgBody.loadUint(64);
    var block: cell = msgBody.loadRef();
    var signatures: cell = msgBody.loadRef();

    if (op == OP_NEW_KEY_BLOCK) {
        processNewKeyBlock(queryId, block, signatures, senderAddress);
    } else if (op == OP_CHECK_BLOCK) {
        processCheckBlock(queryId, block, signatures, senderAddress);
    }
}
