import { NetworkProvider } from "@ton/blueprint";
import { Address, beginCell, Cell, toNano } from "@ton/core";
import { sign } from "@ton/crypto";
import { TonClient } from "@ton/ton";
import { mnemonicNew, mnemonicToWalletKey } from "@ton/crypto";

export async function run() {
  const mnemonicArray = await mnemonicNew(24); // 24 is the number of words in a seed phrase
  const keyPair = await mnemonicToWalletKey(mnemonicArray); // extract private and public keys from mnemonic
  console.log(mnemonicArray); // if we want, we can print our mnemonic

  const codeCell = Cell.fromBase64(
    "te6ccgEBCAEAhgABFP8A9KQT9LzyyAsBAgEgAgMCAUgEBQCW8oMI1xgg0x/TH9MfAvgju/Jj7UTQ0x/TH9P/0VEyuvKhUUS68qIE+QFUEFX5EPKj+ACTINdKltMH1AL7AOgwAaTIyx/LH8v/ye1UAATQMAIBSAYHABe7Oc7UTQ0z8x1wv/gAEbjJftRNDXCx+A=="
  );

  const subWallet = 10;

  const dataCell = beginCell()
    .storeUint(0, 32) // Seqno
    .storeUint(subWallet, 32) // Subwallet ID
    .storeBuffer(keyPair.publicKey) // Public Key
    .endCell();

  const stateInit = beginCell()
    .storeBit(0) // No split_depth
    .storeBit(0) // No special
    .storeBit(1) // We have code
    .storeRef(codeCell)
    .storeBit(1) // We have data
    .storeRef(dataCell)
    .storeBit(0) // No library
    .endCell();

  const contractAddress = new Address(-1, stateInit.hash()); // get the hash of stateInit to get the address of our smart contract in workchain with ID 0
  console.log(`Contract address: ${contractAddress.toRawString()}`);

  const internalMessageBody = beginCell()
    .storeUint(0, 32)
    .storeStringTail("deploy")
    .endCell();

  const internalMessage = beginCell()
    .storeUint(0x10, 6) // no bounce
    .storeAddress(
      Address.parse("Ef9Zk7G5mnBtK2Yf4os13PcbWrgi9dOzmKIic7zQjOMfAJZp")
    )
    .storeCoins(toNano("0.03"))
    .storeUint(1, 1 + 4 + 4 + 64 + 32 + 1 + 1) // We store 1 that means we have body as a reference
    .storeRef(internalMessageBody)
    .endCell();

  // message for our wallet
  const toSign = beginCell()
    .storeUint(subWallet, 32)
    .storeUint(Math.floor(Date.now() / 1e3) + 60, 32)
    .storeUint(0, 32) // We put seqno = 0, because after deploying wallet will store 0 as seqno
    .storeUint(3, 8)
    .storeRef(internalMessage);

  const signature = sign(
    toSign.endCell().hash(),
    keyPair.secretKey
  );
  const body = beginCell()
    .storeBuffer(signature)
    .storeBuilder(toSign)
    .endCell();

  const externalMessage = beginCell()
    .storeUint(0b10, 2) // indicate that it is an incoming external message
    .storeUint(0, 2) // src -> addr_none
    .storeAddress(contractAddress)
    .storeCoins(0) // Import fee
    .storeBit(1) // We have State Init
    .storeBit(1) // We store State Init as a reference
    .storeRef(stateInit) // Store State Init as a reference
    .storeBit(1) // We store Message Body as a reference
    .storeRef(body) // Store Message Body as a reference
    .endCell();

  const client = new TonClient({
    endpoint: "http://109.236.91.95:8081/jsonRPC",
  });

  const result = await client.sendFile(externalMessage.toBoc());
  console.log(result);
}
