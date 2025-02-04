import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Cell, toNano } from "@ton/core";
import { TransactionChecker } from "../wrappers/TransactionChecker";
import "@ton/test-utils";
import { compile } from "@ton/blueprint";

describe("TransactionChecker", () => {
  let code: Cell;

  beforeAll(async () => {
    code = await compile("TransactionChecker");
  });

  let blockchain: Blockchain;
  let deployer: SandboxContract<TreasuryContract>;
  let transactionChecker: SandboxContract<TransactionChecker>;

  beforeEach(async () => {
    blockchain = await Blockchain.create();

    transactionChecker = blockchain.openContract(
      TransactionChecker.createFromConfig({}, code)
    );

    deployer = await blockchain.treasury("deployer");

    const deployResult = await transactionChecker.sendDeploy(
      deployer.getSender(),
      toNano("0.05")
    );

    expect(deployResult.transactions).toHaveTransaction({
      from: deployer.address,
      to: transactionChecker.address,
      deploy: true,
      success: true,
    });
  });

  it("should deploy", async () => {
    // the check is done inside beforeEach
    // blockchain and transactionChecker are ready to use
  });
});
