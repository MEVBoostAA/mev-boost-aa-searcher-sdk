import { BigNumber, BigNumberish, ethers } from "ethers";
import { Signer } from "@ethersproject/abstract-signer";
import { Provider } from "@ethersproject/providers";
import {
  IMEVBoostPaymaster,
  IMEVBoostAccount,
  MEVBoostAccount__factory,
  MEVBoostPaymaster,
  MEVBoostPaymaster__factory,
} from "@mev-boost-aa/contracts";
import { HttpRpcClient } from "./HttpRpcClient";
import { hexDataSlice, resolveProperties } from "ethers/lib/utils";
import { UserOperationStruct } from "@account-abstraction/contracts";
import { arrayify, hexConcat } from "ethers/lib/utils";

MEVBoostPaymaster__factory;
export interface MEVBoostSearcherApiParams {
  provider: Provider;
  signer: Signer;
  mevBoostPaymasterAddress: string;
  bundlerUrl?: string;
}

export interface BoostUserOperationStruct extends UserOperationStruct {
  mevConfig: IMEVBoostAccount.MEVConfigStruct;
}

export class MEVBoostSearcherAPI {
  private readonly mevBoostPaymaster: MEVBoostPaymaster;
  private readonly mevBoostPaymasterAddress: string;
  private readonly signer: Signer;
  private readonly bundlerUrl?: string;
  private readonly provider: Provider;
  private searcher?: string;
  private chainId?: number;
  private entryPointAddress?: string;
  private client?: HttpRpcClient;
  private init: Promise<void>;

  constructor(params: MEVBoostSearcherApiParams) {
    this.signer = params.signer;
    this.provider = params.provider;
    this.bundlerUrl = params.bundlerUrl;
    this.mevBoostPaymasterAddress = params.mevBoostPaymasterAddress;

    this.mevBoostPaymaster = MEVBoostPaymaster__factory.connect(
      this.mevBoostPaymasterAddress,
      this.provider
    ).connect(this.signer);

    const obj = this;
    this.init = (async () => {
      obj.searcher = await params.signer.getAddress();
      const { chainId } = await params.provider.getNetwork();
      obj.chainId = chainId;
      obj.entryPointAddress = await obj.mevBoostPaymaster.entryPoint();
      if (params.bundlerUrl) {
        this.client = new HttpRpcClient(
          params.bundlerUrl,
          obj.entryPointAddress,
          obj.chainId
        );
        // check chainID
      }
    })();
  }

  async deposit(value: BigNumber, target?: string): Promise<BigNumber> {
    await this.init;
    target = target ?? this.searcher!;
    const tx = await this.mevBoostPaymaster.deposit(target, { value });
    await tx.wait();
    console.log(tx);
    return await this.getDeposit(target);
  }

  async getDeposit(target?: string): Promise<BigNumber> {
    await this.init;
    target = target ?? this.searcher!;
    return await this.mevBoostPaymaster.getDeposit(target);
  }

  async withdrawTo(target: string, amount: BigNumber): Promise<BigNumber> {
    await this.init;
    const tx = await this.mevBoostPaymaster.withdrawTo(target, amount);
    await tx.wait();
    console.log(tx);
    return await this.provider.getBalance(target);
  }

  async fetchAllUserOps(): Promise<
    [
      {
        userOp: UserOperationStruct;
        mevConfig: IMEVBoostAccount.MEVConfigStruct;
      }[],
      UserOperationStruct[]
    ]
  > {
    await this.init;
    const userOps = await this.client!.dumpMempool();
    const boostUserOps: {
      userOp: UserOperationStruct;
      mevConfig: IMEVBoostAccount.MEVConfigStruct;
    }[] = [];
    const otherUserOps: UserOperationStruct[] = [];
    for (const userOp of userOps) {
      const mevConfig = await this.checkBoostUserOp(userOp);
      if (mevConfig) {
        boostUserOps.push({ userOp, mevConfig });
      } else {
        otherUserOps.push(userOp);
      }
    }
    return [boostUserOps, otherUserOps];
  }

  async checkBoostUserOp(
    userOp: UserOperationStruct
  ): Promise<null | IMEVBoostAccount.MEVConfigStruct> {
    await this.init;
    const op = await resolveProperties(userOp);
    // assure paymasterAndData is empty
    if (!op.paymasterAndData) {
      // check boostop call data
      const sender = MEVBoostAccount__factory.connect(
        await userOp.sender,
        this.provider
      ).connect(ethers.constants.AddressZero);
      if ((await sender.mevBoostPaymaster()) != this.mevBoostPaymasterAddress) {
        return null;
      }
      try {
        const args = sender.interface.decodeFunctionData(
          "boostExecute",
          op.callData
        );
        return args.mevConfig;
      } catch {
        try {
          const args = sender.interface.decodeFunctionData(
            "boostExecuteBatch",
            op.callData
          );
          return args.mevConfig;
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  async fillBoostUserOps(
    fillAmount: BigNumber,
    mevConfig: IMEVBoostAccount.MEVConfigStruct,
    userOp: UserOperationStruct
  ): Promise<null | UserOperationStruct> {
    await this.init;
    if (
      ethers.BigNumber.from(mevConfig.selfSponsoredAfter).lt(Date.now() / 100)
    ) {
      return null;
    }
    if (ethers.BigNumber.from(mevConfig.minAmount).gt(fillAmount)) {
      return null;
    }
    // use minAmount
    const mevPayInfo: IMEVBoostPaymaster.MEVPayInfoStruct =
      await this.mevBoostPaymaster.getMEVPayInfo(this.searcher!, userOp);

    const mevPayInfoHash = await this.mevBoostPaymaster.getMEVPayInfoHash(
      mevPayInfo
    );

    const signature = await this.signer.signMessage(arrayify(mevPayInfoHash));
    mevPayInfo.signature = signature;

    const paymasterAndData = ethers.utils.solidityPack(
      ["address", "bytes"],
      [
        this.searcher!,
        ethers.utils.defaultAbiCoder.encode(
          ["tuple(address,bytes32,uint256,bytes)"],
          [mevPayInfo]
        ),
      ]
    );
    userOp.paymasterAndData = paymasterAndData;
    return userOp;
  }
}
