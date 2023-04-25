import { JsonRpcProvider } from "@ethersproject/providers";
import { ethers } from "ethers";
import { resolveProperties } from "ethers/lib/utils";
import { UserOperationStruct } from "@account-abstraction/contracts";
import Debug from "debug";
import { deepHexlify } from "@account-abstraction/utils";

const debug = Debug("aa.rpc");

export class HttpRpcClient {
  private readonly userOpJsonRpcProvider: JsonRpcProvider;

  initializing: Promise<[void, void]>;

  constructor(
    readonly bundlerUrl: string,
    readonly entryPointAddress: string,
    readonly chainId: number
  ) {
    this.userOpJsonRpcProvider = new ethers.providers.JsonRpcProvider(
      this.bundlerUrl,
      {
        name: "Connected bundler network",
        chainId,
      }
    );
    this.initializing = Promise.all([
      this.validateChainId(),
      this.validateEntryPoint(),
    ]);
  }

  async validateEntryPoint(): Promise<void> {
    const entryPoints = await this.userOpJsonRpcProvider.send(
      "eth_supportedEntryPoints",
      []
    );
    if (!entryPoints.includes(this.entryPointAddress)) {
      throw new Error(
        `bundler ${this.bundlerUrl} supports entrypoints=[${entryPoints}], but get ${this.entryPointAddress}`
      );
    }
  }

  async validateChainId(): Promise<void> {
    // validate chainId is in sync with expected chainid
    const chain = await this.userOpJsonRpcProvider.send("eth_chainId", []);
    const bundlerChain = parseInt(chain);
    if (bundlerChain !== this.chainId) {
      throw new Error(
        `bundler ${this.bundlerUrl} is on chainId ${bundlerChain}, but provider is on chainId ${this.chainId}`
      );
    }
  }

  /**
   * send a UserOperation to the bundler
   * @param userOp1
   * @return userOpHash the id of this operation, for getUserOperationTransaction
   */
  async sendUserOpToBundler(userOp1: UserOperationStruct): Promise<string> {
    await this.initializing;
    const hexifiedUserOp = deepHexlify(await resolveProperties(userOp1));
    const jsonRequestData: [UserOperationStruct, string] = [
      hexifiedUserOp,
      this.entryPointAddress,
    ];
    await this.printUserOperation("eth_sendUserOperation", jsonRequestData);
    return await this.userOpJsonRpcProvider.send("eth_sendUserOperation", [
      hexifiedUserOp,
      this.entryPointAddress,
    ]);
  }

  async dumpMempool(): Promise<UserOperationStruct[]> {
    return await this.userOpJsonRpcProvider.send("debug_bundler_dumpMempool", [
      this.entryPointAddress,
    ]);
  }

  async estimateUserOpGas(
    userOp1: Partial<UserOperationStruct>
  ): Promise<string> {
    await this.initializing;
    const hexifiedUserOp = deepHexlify(await resolveProperties(userOp1));
    const jsonRequestData: [UserOperationStruct, string] = [
      hexifiedUserOp,
      this.entryPointAddress,
    ];
    await this.printUserOperation(
      "eth_estimateUserOperationGas",
      jsonRequestData
    );
    return await this.userOpJsonRpcProvider.send(
      "eth_estimateUserOperationGas",
      [hexifiedUserOp, this.entryPointAddress]
    );
  }

  private async printUserOperation(
    method: string,
    [userOp1, entryPointAddress]: [UserOperationStruct, string]
  ): Promise<void> {
    const userOp = await resolveProperties(userOp1);
    debug(
      "sending",
      method,
      {
        ...userOp,
        // initCode: (userOp.initCode ?? '').length,
        // callData: (userOp.callData ?? '').length
      },
      entryPointAddress
    );
  }
}
