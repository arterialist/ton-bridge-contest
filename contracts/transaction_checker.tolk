import "@stdlib/tvm-dicts"

tolk 0.6

fun isTransactionInAccountBlocks(accountBlocks: cell, transaction: cell) {
    var transactionHash = transaction.cellHash();
    var accountBlocksDict = accountBlocks.beginParse().loadDict();

    var (account, accBlock, found) = accountBlocksDict.uDictGetFirstAsRef(256);

    if (accBlock == null) { return 0; }
    
    // do {
    //     var accBlockType = accBlock.loadUint(4);
    //     if (accBlockType != 0x5) { throw 0x00002001; }

    //     var accAddress = accBlock.loadBits(256);
    //         (account, accBlock, found) = accountBlocksDict.uDictGetNext(256, account);
    // } while (found != 0);

    return -1;
}

fun checkTransaction(queryId: int, transaction: cell, proof: cell, current_block: cell) {
    // var proofSlice = proof.beginParse();
    // var proofExoticCellType = proofSlice.loadUint(8);
    // if (proofExoticCellType != 3) { throw 0x00001001; }

    // var proofContentHash = proofSlice.loadUint(256);
    // var currentBlockSlice = current_block.beginParse();
    // var currentBlockBlock = currentBlockSlice.loadRef();
    // if (currentBlockBlock.cellHash() != proofContentHash) { throw 0x00001002; }

    // var currentBlockProof = currentBlockSlice.loadRef();
    // var currentBlockProofSlice = currentBlockProof.beginParse();
    // var currentBlockProofExoticCellType = currentBlockProofSlice.loadUint(8);
    // if (currentBlockProofExoticCellType != 3) { throw 0x00001003; }

    // var currentBlockProofContentHash = currentBlockProofSlice.loadUint(256);
    // if (currentBlockProofContentHash != currentBlockBlock.cellHash()) { throw 0x00001004; }

    var blockSlice = current_block.beginParse();
    blockSlice.loadUint(32); // skip magic prefix
    blockSlice.loadInt(32); // skip global_id
    blockSlice.loadRef(); // skip block_info
    blockSlice.loadRef(); // skip value_flow
    blockSlice.loadRef(); // skip state_update
    var extra = blockSlice.loadRef();
    var extraSlice: slice = extra.beginParse();

    extraSlice.loadUint(32); // skip magic prefix
    extraSlice.loadRef(); // skip in_msg_descr
    extraSlice.loadRef(); // skip out_msg_descr
    var accountBlocks = extraSlice.loadRef(); // get account_blocks dict

    var isTransactionInAccountBlocks = isTransactionInAccountBlocks(accountBlocks, transaction);
    if (isTransactionInAccountBlocks == 0) { throw 0x00001005; }

    return -1;
}

fun onInternalMessage(myBalance: int, msgValue: int, msgFull: cell, msgBody: slice) {
    if (msgBody.isEndOfSlice()) { return; }

    val op = msgBody.loadMessageOp();

    if (op != 0x91d555f7) { throw 0xffff; }

    if (op == 0x91d555f7) {
        var queryId = msgBody.loadMessageQueryId();
        var transaction = msgBody.loadRef();
        var proof = msgBody.loadRef();
        var current_block = msgBody.loadRef();  
        checkTransaction(queryId, transaction, proof, current_block);
    }
}
