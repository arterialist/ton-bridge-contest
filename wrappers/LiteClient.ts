import {
  Address,
  beginCell,
  Cell,
  Contract,
  contractAddress,
  ContractProvider,
  Dictionary,
  Sender,
  SendMode,
  toNano,
} from "@ton/core";
import { liteServer_BlockData } from "ton-lite-client/dist/schema";

export type LiteClientConfig = {
  validators_hash: Buffer;
};

export function liteClientConfigToCell(config: LiteClientConfig): Cell {
  return beginCell().storeBuffer(config.validators_hash).endCell();
}

export class LiteClient implements Contract {
  constructor(
    readonly address: Address,
    readonly init?: { code: Cell; data: Cell }
  ) {}

  static createFromAddress(address: Address) {
    return new LiteClient(address);
  }

  static createFromConfig(config: LiteClientConfig, code: Cell, workchain = 0) {
    const data = liteClientConfigToCell(config);
    const init = { code, data };
    return new LiteClient(contractAddress(workchain, init), init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().endCell(),
    });
  }

  async sendNewKeyBlock(
    provider: ContractProvider,
    via: Sender,
    fullBlock: liteServer_BlockData,
    signatures: Dictionary<Buffer, Buffer>
  ) {
    await provider.internal(via, {
      value: toNano("0.05"),
      body: beginCell()
        .storeUint(0x11a78ffe, 32)
        .storeUint(0, 64)
        .storeRef(Cell.fromBase64(fullBlock.data.toString("base64")))
        .storeRef(
          beginCell()
            .storeBuffer(fullBlock.id.fileHash, 32)
            .storeDict(signatures)
            .endCell()
        )
        .endCell(),
    });
  }

  async sendCheckBlock(
    provider: ContractProvider,
    via: Sender,
    fullBlock: liteServer_BlockData,
    signatures: Dictionary<Buffer, Buffer>
  ) {
    await provider.internal(via, {
      value: toNano("0.05"),
      body: beginCell()
        .storeUint(0x8eaa9d76, 32)
        .storeUint(0, 64)
        .storeRef(Cell.fromBase64(fullBlock.data.toString("base64")))
        .storeRef(
          beginCell()
            .storeBuffer(fullBlock.id.fileHash, 32)
            .storeDict(signatures)
            .endCell()
        )
        .endCell(),
    });
  }
}
