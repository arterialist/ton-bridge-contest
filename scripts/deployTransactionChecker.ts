import { Address, Cell, Dictionary, toNano, Builder, Slice } from "@ton/core";
import { TransactionChecker } from "../wrappers/TransactionChecker";
import { compile, NetworkProvider } from "@ton/blueprint";
import { TonClient } from "@ton/ton";
import { LiteSingleEngine } from "ton-lite-client";
import { LiteClient, LiteRoundRobinEngine } from "ton-lite-client";
import { LiteEngine } from "ton-lite-client";
import { Functions } from "ton-lite-client/dist/schema";

const ENDPOINTS = {
  testnet: "https://testnet.toncenter.com/api/v2/",
  fastnet: "http://109.236.91.95:8081/",
};

const RPC_CLIENTS = {
  testnet: new TonClient({
    endpoint: "https://testnet.toncenter.com/api/v2/jsonRPC",
  }),
  fastnet: new TonClient({ endpoint: "http://109.236.91.95:8081/jsonRPC" }),
};

const CONFIGS = {
  testnet: "https://ton-blockchain.github.io/testnet-global.config.json",
  fastnet:
    "https://contest.com/file/400780400604/4/P0UeFR_X1mg.1626.json/04de18101ec5af6dea",
};

const SAMPLE_ADDRESSES = {
  testnet: "EQBVQSJ0QRf0QU8CyjRvwjJOKrObUCPCE2VkbVPRfyCaV1NY",
  fastnet: "EQBVQSJ0QRf0QU8CyjRvwjJOKrObUCPCE2VkbVPRfyCaV1NY",
};

type Network = "testnet" | "fastnet";

const rateLimit = (() => {
  let lastCall = 0;
  return async () => {
    const now = Date.now();
    const diff = now - lastCall;
    if (diff < 1100) {
      await new Promise((resolve) => setTimeout(resolve, 1100 - diff));
    }
    lastCall = Date.now();
  };
})();

const fetchWithRateLimit = async (url: string, retries = 3) => {
  await rateLimit();
  try {
    const response = await fetch(url);
    if (!response.ok) {
      if (retries > 0) {
        console.log(`Request failed, retrying ${retries} more times`);
        await new Promise((resolve) => setTimeout(resolve, 1100));
        return fetchWithRateLimit(url, retries - 1);
      }
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response;
  } catch (error) {
    if (retries > 0) {
      console.log(`Request failed, retrying ${retries} more times`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return fetchWithRateLimit(url, retries - 1);
    }
    throw error;
  }
};

async function getLiteserversFromConfig(network: Network) {
  const endpoint = CONFIGS[network];
  console.log("Getting liteservers from", endpoint);
  const config = await fetchWithRateLimit(endpoint).then((data) => data.json());
  return config.liteservers;
}

function intToIP(int: number) {
  var part1 = int & 255;
  var part2 = (int >> 8) & 255;
  var part3 = (int >> 16) & 255;
  var part4 = (int >> 24) & 255;

  return part4 + "." + part3 + "." + part2 + "." + part1;
}

async function initLiteserver(network: Network) {
  const liteservers = await getLiteserversFromConfig(network);
  const server = liteservers[0];
  const engines: LiteEngine[] = [];
  engines.push(
    new LiteSingleEngine({
      host: `tcp://${intToIP(server.ip)}:${server.port}`,
      publicKey: Buffer.from(server.id.key, "base64"),
    })
  );
  const engine: LiteEngine = new LiteRoundRobinEngine(engines);
  const client = new LiteClient({ engine });
  return { engine, client };
}

function parseTransaction(transaction: Cell) {
  const transactionSlice = transaction.beginParse();
  const transactionType = transactionSlice.loadUint(4);
  console.log("transactionType", transactionType);
}

function parseBlock(block: Cell) {
  let blockSlice = block.beginParse(true);
  if (block.isExotic) {
    console.log("block is exotic");
    blockSlice = blockSlice.loadRef().beginParse(true);
  }
  const magicPrefix = blockSlice.loadUint(32);
  const globalId = blockSlice.loadInt(32);

  // block_info#9bc7a987 version:uint32
  // not_master:(## 1)
  // after_merge:(## 1) before_split:(## 1)
  // after_split:(## 1)
  // want_split:Bool want_merge:Bool
  // key_block:Bool vert_seqno_incr:(## 1)
  // flags:(## 8) { flags <= 1 }
  // seq_no:# vert_seq_no:# { vert_seq_no >= vert_seqno_incr }
  // { prev_seq_no:# } { ~prev_seq_no + 1 = seq_no }
  // shard:ShardIdent gen_utime:uint32
  // start_lt:uint64 end_lt:uint64
  // gen_validator_list_hash_short:uint32
  // gen_catchain_seqno:uint32
  // min_ref_mc_seqno:uint32
  // prev_key_block_seqno:uint32
  // gen_software:flags . 0?GlobalVersion
  // master_ref:not_master?^BlkMasterInfo
  // prev_ref:^(BlkPrevInfo after_merge)
  // prev_vert_ref:vert_seqno_incr?^(BlkPrevInfo 0)
  // = BlockInfo;

  const blockInfo = blockSlice.loadRef().beginParse(true);
  const magicPrefix2 = blockInfo.loadUint(32);
  const version = blockInfo.loadUint(32);
  const notMaster = blockInfo.loadUint(1);
  const afterMerge = blockInfo.loadUint(1);
  const beforeSplit = blockInfo.loadUint(1);
  const afterSplit = blockInfo.loadUint(1);
  const wantSplit = blockInfo.loadUint(1);
  const wantMerge = blockInfo.loadUint(1);
  const keyBlock = blockInfo.loadUint(1);
  const vertSeqnoIncr = blockInfo.loadUint(1);
  const flags = blockInfo.loadUint(8);
  const seqNo = blockInfo.loadUint(32);
  const vertSeqNo = blockInfo.loadUint(32);
  const prevSeqNo = seqNo - 1;

  const shardIdent = blockInfo.loadUint(2);
  const shardPrefixBits = blockInfo.loadUint(6);
  const workchainId = blockInfo.loadInt(32);
  const shardId = blockInfo.loadUintBig(64);

  const genUtime = blockInfo.loadUint(32);
  const startLt = blockInfo.loadUintBig(64);
  const endLt = blockInfo.loadUintBig(64);
  const genValidatorListHashShort = blockInfo.loadUint(32);
  const genCatchainSeqno = blockInfo.loadUint(32);
  const minRefMcSeqno = blockInfo.loadUint(32);
  const prevKeyBlockSeqno = blockInfo.loadUint(32);

  const valueFlow = blockSlice.loadRef();
  const stateUpdate = blockSlice.loadRef();
  const extraRef = blockSlice.loadRef();

  let magicPrefix3;
  let inMsgDescr;
  let outMsgDescr;
  let accountBlocks;
  let randSeed;
  let createdBy;

  let magicPrefix4;
  let isKeyBlock;
  let shardHashes;
  let shardFees;
  let prevBlkSignatures;
  let recoverCreateMsg;
  let mintMsg;
  let configAddress;
  let configParams;

  if (!block.isExotic) {
    const extra = extraRef.beginParse(true);

    magicPrefix3 = extra.loadUint(32);
    console.log("magicPrefix3", magicPrefix3.toString(16));
    inMsgDescr = extra.loadRef();
    outMsgDescr = extra.loadRef();
    accountBlocks = extra
      .loadRef()
      .beginParse()
      .loadDict(Dictionary.Keys.BigUint(256), {
        serialize(src: Cell, builder: Builder) {},
        parse(src: Slice): Cell {
          return src.asCell();
        },
      });

    for (const [key, value] of accountBlocks) {
      console.log("key", key.toString(16));
      console.log("value", value);
      // acc_trans#5 account_addr:bits256
      //       transactions:(HashmapAug 64 ^Transaction CurrencyCollection)
      //       state_update:^(HASH_UPDATE Account)
      //     = AccountBlock;

      // const valueSlice = value.beginParse();
      // const accountBlock = valueSlice.loadRef().beginParse();
      // console.log("accountBlock", accountBlock);
      // const accountBlockPrefix = accountBlock.loadUint(4);
      // console.log("accountBlockPrefix", accountBlockPrefix);
      // // const accountAddr = accountBlock.loadBits(256);
      // // console.log("accountAddr", accountAddr.toString());
      // const transactions = accountBlock.loadRef().beginParse().loadDictDirect(Dictionary.Keys.BigUint(64), {
      //   serialize(src: Cell, builder: Builder) {},
      //   parse(src: Slice): Cell {
      //     return src.asCell();
      //   },
      // });
      // console.log("transactions", transactions);
      // const stateUpdate = valueSlice.loadRef();
      // console.log("stateUpdate", stateUpdate.toBoc().toString("base64"));
    }

    console.log("accountBlocks", accountBlocks);

    randSeed = extra.loadBits(256);
    createdBy = extra.loadBits(256);

    const mcBlockExtra = extra.loadRef().beginParse(true);
    magicPrefix4 = mcBlockExtra.loadUint(16);
    isKeyBlock = mcBlockExtra.loadUint(1);

    shardHashes = mcBlockExtra.loadMaybeRef();
    shardFees = mcBlockExtra.loadMaybeRef();
    prevBlkSignatures = mcBlockExtra.loadMaybeRef();
    recoverCreateMsg = mcBlockExtra.loadMaybeRef();
    mintMsg = mcBlockExtra.loadMaybeRef();

    if (isKeyBlock) {
      configAddress = mcBlockExtra.loadBits(256);
      configParams = mcBlockExtra
        .loadRef()
        .beginParse()
        .loadDictDirect(Dictionary.Keys.Uint(32), {
          serialize(src: Cell, builder: Builder) {},
          parse(src: Slice): Cell {
            return src.asCell();
          },
        });
    }
  }

  return {
    globalId,
    blockInfo: {
      magicPrefix2: magicPrefix2.toString(16),
      version,
      notMaster,
      afterMerge,
      beforeSplit,
      afterSplit,
      wantSplit,
      wantMerge,
      keyBlock,
      vertSeqnoIncr,
      flags,
      seqNo,
      vertSeqNo,
      prevSeqNo,
      shardIdent,
      shardPrefixBits,
      workchainId,
      shardId,
      genUtime,
      startLt,
      endLt,
      genValidatorListHashShort,
      genCatchainSeqno,
      minRefMcSeqno,
      prevKeyBlockSeqno,
    },
    extra: {
      magicPrefix3: magicPrefix3?.toString(16),
      inMsgDescr: inMsgDescr?.toBoc().toString("base64"),
      outMsgDescr: outMsgDescr?.toBoc().toString("base64"),
      accountBlocks: accountBlocks,
      randSeed,
      createdBy,
      mcBlockExtra: {
        magicPrefix4: magicPrefix4?.toString(16),
        isKeyBlock,
        shardHashes: shardHashes?.toBoc().toString("base64"),
        shardFees: shardFees?.toBoc().toString("base64"),
        prevBlkSignatures: prevBlkSignatures?.toBoc().toString("base64"),
        recoverCreateMsg: recoverCreateMsg?.toBoc().toString("base64"),
        mintMsg: mintMsg?.toBoc().toString("base64"),
        configAddress: configAddress,
        configParams,
      },
    },
  };
}

async function prepareNetworkInfo(network: Network) {
  const { engine, client } = await initLiteserver(network);
  const masterChainInfo = await client.getMasterchainInfo();
  const lastFullBlock = await engine.query(Functions.liteServer_getBlock, {
    kind: "liteServer.getBlock",
    id: {
      ...masterChainInfo.last,
    },
  });
  const blockInfo = {
    kind: "tonNode.blockIdExt",
    id: {
      workchain: lastFullBlock.id.workchain,
      shard: lastFullBlock.id.shard,
      seqno: lastFullBlock.id.seqno,
      rootHash: lastFullBlock.id.rootHash, // Replace with actual rootHash
      fileHash: lastFullBlock.id.fileHash, // Replace with actual fileHash
    },
  };
  const lastFullBlockHeader = await engine.query(
    Functions.liteServer_getBlockHeader,
    blockInfo
  );
  const address = Address.parse(SAMPLE_ADDRESSES[network]);
  const accountState = await client.getAccountState(
    address,
    masterChainInfo.last
  );
  const rawTransactions = await client.getAccountTransactions(
    address,
    accountState.lastTx!.lt.toString(10),
    Buffer.from(accountState.lastTx!.hash.toString(16), "hex"),
    1
  );
  const transactionsCell = Cell.fromBoc(rawTransactions.transactions);
  const transactionBlockId = rawTransactions.ids[0];
  const transaction = transactionsCell[0];

  const transactionWithProof = await client.getAccountTransaction(
    address,
    accountState.lastTx!.lt.toString(10),
    transactionBlockId
  );
  console.log("transactionWithProof", transactionWithProof);
  const transactionProofCell = Cell.fromBoc(transactionWithProof.proof)[0];

  console.log("transactionProofCell", transactionProofCell);

  return {
    transaction: transaction,
    proof: transactionProofCell,
    currentBlock: Cell.fromBoc(
      Buffer.from(lastFullBlock.data.toString("hex"), "hex")
    )[0],
  };
}

export async function run(provider: NetworkProvider) {
  const { transaction, proof, currentBlock } =
    await prepareNetworkInfo("testnet");
  const block = parseBlock(currentBlock);
  const transactionChecker = provider.open(
    TransactionChecker.createFromConfig({}, await compile("TransactionChecker"))
  );

  await transactionChecker.sendDeploy(provider.sender(), toNano("0.005"));
  await provider.waitForDeploy(transactionChecker.address);

  await transactionChecker.sendCheckTransaction(
    provider.sender(),
    transaction,
    Cell.EMPTY,
    currentBlock
  );
}
