import {
  Address,
  beginCell,
  Cell,
  Contract,
  contractAddress,
  ContractProvider,
  Sender,
  SendMode,
  toNano,
} from "@ton/core";

export type TransactionCheckerConfig = {};

export function transactionCheckerConfigToCell(
  config: TransactionCheckerConfig
): Cell {
  return beginCell().endCell();
}

export class TransactionChecker implements Contract {
  constructor(
    readonly address: Address,
    readonly init?: { code: Cell; data: Cell }
  ) {}

  static createFromAddress(address: Address) {
    return new TransactionChecker(address);
  }

  static createFromConfig(
    config: TransactionCheckerConfig,
    code: Cell,
    workchain = 0
  ) {
    const data = transactionCheckerConfigToCell(config);
    const init = { code, data };
    return new TransactionChecker(contractAddress(workchain, init), init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().endCell(),
    });
  }

  async sendCheckTransaction(
    provider: ContractProvider,
    via: Sender,
    transaction: Cell,
    proof: Cell,
    currentBlock: Cell
  ) {
    await provider.internal(via, {
      value: toNano("0.01"),
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(0x91d555f7, 32)
        .storeUint(0, 64)
        .storeRef(transaction)
        .storeRef(proof)
        .storeRef(currentBlock)
        .endCell(),
    });
  }
}
