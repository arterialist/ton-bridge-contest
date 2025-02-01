import {
  Address,
  beginCell,
  Builder,
  Cell,
  Dictionary,
  DictionaryKey,
  DictionaryKeyTypes,
  Slice,
  toNano,
} from "@ton/core";
import { LiteClient as LiteClientContract } from "../wrappers/LiteClient";
import { compile, NetworkProvider, sleep } from "@ton/blueprint";
import {
  LiteEngine,
  LiteSingleEngine,
  LiteRoundRobinEngine,
  LiteClient,
} from "ton-lite-client";
import { Functions, tonNode_blockIdExt } from "ton-lite-client/dist/schema";
import { TonClient } from "@ton/ton";
import { sha256 } from "@ton/crypto";
import { assert } from "node:console";
import crypto from "crypto";
import { createHash } from "node:crypto";

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

async function parseValidators(validators: Cell) {
  // validators#11 utime_since:uint32 utime_until:uint32
  // total:(## 16) main:(## 16) { main <= total } { main >= 1 }
  // list:(Hashmap 16 ValidatorDescr) = ValidatorSet;

  let slice = validators.beginParse();
  let type = slice.loadUint(8);
  let utimeSince = slice.loadUint(32); // utime_since
  let utimeUntil = slice.loadUint(32); // utime_until
  let total = slice.loadBits(16); // total
  let main = slice.loadBits(16); // main
  // BitString to number
  let totalNumber = parseInt(total.toString(), 16);
  let mainNumber = parseInt(main.toString(), 16);

  if (type == 18) {
    let totalWeight = slice.loadUintBig(64);
  }

  const validatorsDictCell = slice.loadMaybeRef();
  if (!validatorsDictCell) {
    throw new Error("Failed to load validators dictionary");
  }
  const nodeIdPrefix = Buffer.from([0xc6, 0xb4, 0x13, 0x48]);

  let validatorsDict = validatorsDictCell
    .beginParse()
    .loadDictDirect(Dictionary.Keys.Uint(16), {
      serialize(src: Cell, builder: Builder) {},
      parse(src: Slice): Cell {
        return src.asCell();
      },
    });

  let parsedValidators: {
    nodeId: Buffer;
    nodeIdHex: string;
    publicKey: Buffer;
    weight: number;
  }[] = [];

  for (const [key, value] of validatorsDict!) {
    const validatorSlice = (value as Cell).beginParse();
    const type = validatorSlice.loadUint(8); // skip validator descriptor type
    validatorSlice.loadUint(32); // skip public key prefix

    const publicKey = validatorSlice.loadBits(256);
    const publicKeyBuffer = Buffer.from(publicKey.toString(), "hex");
    const weight = validatorSlice.loadUintBig(64);
    if (type == 0x73) validatorSlice.loadBuffer(32); // skip adnl address
    let nodeId = await sha256(Buffer.concat([nodeIdPrefix, publicKeyBuffer]));
    // log public key as number
    parsedValidators.push({
      nodeId: nodeId,
      nodeIdHex: nodeId.toString("hex"),
      publicKey: publicKeyBuffer,
      weight: +weight.toString(),
    });
  }

  return parsedValidators;
}

async function getValidatorsHash(network: Network) {
  const endpoint = `${ENDPOINTS[network]}getConfigParam?config_id=34`;
  console.log("Getting validators hash from", endpoint);
  const validatorsConfig = await fetchWithRateLimit(endpoint).then((data) =>
    data.json()
  );
  if (!validatorsConfig.ok)
    throw new Error(`Failed to get config param 34 from ${endpoint}`);

  const validators = Cell.fromBase64(validatorsConfig.result.config.bytes);
  const parsedValidators = await parseValidators(validators);
  return {
    parsedValidators,
    validatorsHash: validators.hash(),
  };
}

async function getLastMasterchainBlock(network: Network) {
  const endpoint = `${ENDPOINTS[network]}getMasterchainInfo`;
  console.log("Getting last masterchain block from", endpoint);
  const lastBlock = await fetchWithRateLimit(endpoint).then((data) =>
    data.json()
  );
  if (!lastBlock.ok) throw new Error("Failed to get last masterchain block");
  return lastBlock.result.last;
}

async function getMasterchainBlockSignatures(network: Network, seqno: number) {
  const endpoint = `${ENDPOINTS[network]}getMasterchainBlockSignatures?seqno=${seqno}`;
  console.log("Getting block signatures from", endpoint);
  const blockSignatures = await fetchWithRateLimit(endpoint).then((data) =>
    data.json()
  );
  if (!blockSignatures.ok) throw new Error("Failed to get block signatures");
  return blockSignatures.result.signatures;
}

function pubkeyHexToEd25519DER(publicKey: string) {
  const key = Buffer.from(publicKey, "hex");

  // Ed25519's OID
  const oid = Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]);

  // Create a byte sequence containing the OID and key
  const elements = Buffer.concat([
    Buffer.concat([
      Buffer.from([0x30]), // Sequence tag
      Buffer.from([oid.length]),
      oid,
    ]),
    Buffer.concat([
      Buffer.from([0x03]), // Bit tag
      Buffer.from([key.length + 1]),
      Buffer.from([0x00]), // Zero bit
      key,
    ]),
  ]);

  // Wrap up by creating a sequence of elements
  const der = Buffer.concat([
    Buffer.from([0x30]), // Sequence tag
    Buffer.from([elements.length]),
    elements,
  ]);

  return der;
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

function parseBlock(block: Cell) {
  const blockSlice = block.beginParse();
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

  const blockInfo = blockSlice.loadRef().beginParse();
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
  const extra = blockSlice.loadRef().beginParse();

  const magicPrefix3 = extra.loadUint(32);
  const inMsgDescr = extra.loadRef();
  const outMsgDescr = extra.loadRef();
  const accountBlocks = extra.loadRef();
  const randSeed = extra.loadBits(256);
  const createdBy = extra.loadBits(256);

  const mcBlockExtra = extra.loadRef().beginParse();
  const magicPrefix4 = mcBlockExtra.loadUint(16);
  const isKeyBlock = mcBlockExtra.loadUint(1);

  let shardHashes = mcBlockExtra.loadMaybeRef();
  let shardFees = mcBlockExtra.loadMaybeRef();
  let prevBlkSignatures;
  let recoverCreateMsg;
  let mintMsg;

  let configAddress;
  let configParams;
  if (isKeyBlock) {
    prevBlkSignatures = mcBlockExtra.loadMaybeRef();
    recoverCreateMsg = mcBlockExtra.loadMaybeRef();
    mintMsg = mcBlockExtra.loadMaybeRef();
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
    console.log("configParams keys", configParams.keys());
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
      magicPrefix3: magicPrefix3.toString(16),
      inMsgDescr: inMsgDescr.toBoc().toString("base64"),
      outMsgDescr: outMsgDescr.toBoc().toString("base64"),
      accountBlocks: accountBlocks.toBoc().toString("base64"),
      randSeed,
      createdBy,
      mcBlockExtra: {
        magicPrefix4: magicPrefix4.toString(16),
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
  // const { parsedValidators, validatorsHash } = await getValidatorsHash(network);
  const lastFullBlock = await engine.query(Functions.liteServer_getBlock, {
    kind: "liteServer.getBlock",
    id: {
      ...masterChainInfo.last,
    },
  });
  const parsedBlock = parseBlock(
    Cell.fromBase64(lastFullBlock.data.toString("base64"))
  );
  const lastKeyBlocks = await client.getFullBlock(
    parsedBlock.blockInfo.prevKeyBlockSeqno
  );
  const lastKeyBlock = lastKeyBlocks.shards.find(
    (shard) => shard.seqno === parsedBlock.blockInfo.prevKeyBlockSeqno
  )!;
  const blockInfo = {
    kind: "tonNode.blockIdExt",
    id: {
      workchain: lastKeyBlock.workchain,
      shard: lastKeyBlock.shard,
      seqno: lastKeyBlock.seqno,
      rootHash: lastKeyBlock.rootHash, // Replace with actual rootHash
      fileHash: lastKeyBlock.fileHash, // Replace with actual fileHash
    },
  };
  const lastFullKeyBlock = await engine.query(
    Functions.liteServer_getBlock,
    blockInfo
  );
  const parsedKeyBlock = parseBlock(
    Cell.fromBase64(lastFullKeyBlock.data.toString("base64"))
  );
  console.log("parsedKeyBlock", parsedKeyBlock);
  const validatorsFromConfig = parsedKeyBlock.extra.mcBlockExtra
    .configParams!.get(32)!
    .beginParse()
    .loadRef();
  const validatorsHash = validatorsFromConfig?.hash();
  const parsedValidators = await parseValidators(validatorsFromConfig!);
  const blockSignatures = await getMasterchainBlockSignatures(
    network,
    parsedKeyBlock.blockInfo.seqNo
  );
  const signaturesDict = Dictionary.empty(
    Dictionary.Keys.Buffer(32),
    Dictionary.Values.Buffer(64)
  );
  const signaturesRaw: {
    node_id: Buffer;
    node_id_short: string;
    signature: string;
  }[] = [];
  for (const signature of blockSignatures) {
    const nodeId = Buffer.from(signature.node_id_short, "base64");
    const signatureBuffer = Buffer.from(signature.signature, "base64");
    signaturesDict.set(nodeId, signatureBuffer);
    signaturesRaw.push({
      node_id: nodeId,
      node_id_short: Buffer.from(signature.node_id_short, "base64").toString(
        "hex"
      ),
      signature: signature.signature,
    });
  }
  return {
    liteServerClient: { engine, client },
    validators: { parsedValidators, validatorsHash },
    masterChainInfo,
    lastFullKeyBlock,
    signatures: {
      raw: signaturesRaw,
      dict: signaturesDict,
    },
  };
}

async function getWalletSeqno(address: string, network: Network) {
  const rpcClient = RPC_CLIENTS[network];
  const seqnoResult = await rpcClient.runMethod(
    Address.parse(address),
    "seqno"
  );
  return seqnoResult.stack.readNumber();
}

export async function run(provider: NetworkProvider) {
  // const {
  //   liteServerClient: fastnetLiteServerClient,
  //   validators: fastnetValidators,
  //   masterChainInfo: fastnetMasterChainInfo,
  //   lastFullKeyBlock: fastnetFullKeyBlock,
  //   signatures: fastnetSignatures,
  // } = await prepareNetworkInfo("fastnet");

  const {
    liteServerClient: testnetLiteServerClient,
    validators: testnetValidators,
    masterChainInfo: testnetMasterChainInfo,
    lastFullKeyBlock: testnetFullKeyBlock,
    signatures: testnetSignatures,
  } = await prepareNetworkInfo("testnet");

  // console.log("Fastnet validators hash:", fastnetValidators.validatorsHash);
  // console.log("Fastnet validators:", fastnetValidators.parsedValidators);
  // console.log("Fastnet masterchain info:", fastnetMasterChainInfo);
  // console.log("Fastnet full block:", fastnetFullKeyBlock);
  // console.log("Fastnet signatures:", fastnetSignatures);

  console.log("Testnet validators hash:", testnetValidators.validatorsHash);
  console.log("Testnet validators:", testnetValidators.parsedValidators);
  console.log("Testnet masterchain info:", testnetMasterChainInfo);
  console.log("Testnet full block:", testnetFullKeyBlock);
  console.log(
    "Testnet full block hash",
    Cell.fromBase64(testnetFullKeyBlock.data.toString("base64"))
      .hash()
      .toString("hex")
  );
  console.log("Testnet signatures raw:", testnetSignatures.raw);
  console.log("Testnet signatures dict:", testnetSignatures.dict);

  const message = Buffer.concat([
    Buffer.from([0x70, 0x6e, 0x0b, 0xc5]),
    Cell.fromBase64(testnetFullKeyBlock.data.toString("base64")).hash(),
    testnetFullKeyBlock.id.fileHash,
  ]);

  const messageCell = beginCell()
    .storeUint(0x70, 8)
    .storeUint(0x6e, 8)
    .storeUint(0x0b, 8)
    .storeUint(0xc5, 8)
    .storeBuffer(
      Cell.fromBase64(testnetFullKeyBlock.data.toString("base64")).hash()
    )
    .storeBuffer(testnetFullKeyBlock.id.fileHash)
    .endCell();

  // compare messageCell with message
  console.log(
    "messageCell",
    messageCell
      .beginParse()
      .loadUintBig(256 + 256 + 8 + 8 + 8 + 8)
      .toString(16)
  );
  console.log("message", message.toString("hex"));

  // calculate sha256 of messageCell
  console.log("sha256 of messageCell", messageCell.hash().toString("hex"));
  // calculate sha256 of messageCell content
  console.log(
    "sha256 of messageCell content",
    createHash("sha256")
      .update(
        messageCell
          .beginParse()
          .loadUintBig(256 + 256 + 8 + 8 + 8 + 8)
          .toString(16)
      )
      .digest("hex")
  );

  const sumLargestTotalWeights = testnetValidators.parsedValidators
    .sort((a, b) => Number(b.weight - a.weight))
    .slice(0, 100)
    .map((val) => val.weight)
    .reduce((prev, cur) => prev + cur);

  let totalWeight = 0;
  for (const item of testnetSignatures.raw) {
    const validator = testnetValidators.parsedValidators.find(
      (val) => val.nodeIdHex === item.node_id_short
    );
    if (!validator) continue;

    console.log("validator", validator);
    console.log("item", item);
    console.log("message", message);

    const key = pubkeyHexToEd25519DER(validator.publicKey.toString("hex"));
    const verifyKey = crypto.createPublicKey({
      format: "der",
      type: "spki",
      key,
    });
    const result = crypto.verify(
      null,
      message,
      verifyKey,
      Buffer.from(item.signature, "base64")
    );
    assert(result === true);
    totalWeight += validator.weight;
  }
  console.log("Total weight:", totalWeight);
  console.log("Sum of largest 100 validator weights:", sumLargestTotalWeights);
  console.log("Block is valid:", totalWeight * 3 > sumLargestTotalWeights * 2);

  // console.log(
  //   "Testnet validators hash:",
  //   testnetValidatorsHash.toString("hex")
  // );
  // console.log("Testnet masterchain info:", testnetMasterChainInfo);
  // console.log("Testnet full block:", testnetFullKeyBlock);
  // console.log("Testnet signatures:", testnetSignatures);

  // console.log(
  //   "Fastnet validators hash:",
  //   fastnetValidatorsHash.toString("hex")
  // );
  // console.log("Fastnet masterchain info:", fastnetMasterChainInfo);
  // console.log("Fastnet full block:", fastnetFullKeyBlock);
  // console.log("Fastnet signatures:", fastnetSignatures);

  const testnetLiteClientContract = provider.open(
    LiteClientContract.createFromConfig(
      { validators_hash: testnetValidators.validatorsHash },
      await compile("LiteClient")
    )
  );
  await testnetLiteClientContract.sendDeploy(provider.sender(), toNano("0.01"));
  await provider.waitForDeploy(testnetLiteClientContract.address);

  // const fastnetLiteClientContract = provider.open(
  //   LiteClientContract.createFromConfig(
  //     { validators_hash: testnetValidatorsHash },
  //     await compile("LiteClient")
  //   )
  // );
  // await fastnetLiteClientContract.sendDeploy(provider.sender(), toNano("0.01"));f
  // await provider.waitForDeploy(fastnetLiteClientContract.address);

  await testnetLiteClientContract.sendNewKeyBlock(
    provider.sender(),
    testnetFullKeyBlock,
    testnetSignatures.dict
  );

  await testnetLiteClientContract.sendCheckBlock(
    provider.sender(),
    testnetFullKeyBlock,
    testnetSignatures.dict
  );

  // await fastnetLiteClientContract.sendNewKeyBlock(
  //   provider.sender(),
  //   testnetFullKeyBlock,
  //   testnetSignatures
  // );
}
