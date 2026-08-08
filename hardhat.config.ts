import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  chainDescriptors: {
    43_111: {
      name: "Hemi Mainnet",
      chainType: "generic",
      blockExplorers: {
        blockscout: {
          name: "Hemi Explorer",
          url: "https://explorer.hemi.xyz",
          apiUrl: "https://explorer.hemi.xyz/api",
        },
      },
    },
  },
  verify: {
    blockscout: { enabled: true },
    etherscan: { enabled: false },
    sourcify: { enabled: false },
  },
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          evmVersion: "paris",
        },
      },
      production: {
        version: "0.8.28",
        settings: {
          evmVersion: "paris",
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hemi: {
      type: "http",
      chainType: "generic",
      chainId: 43_111,
      url: configVariable("HEMI_RPC_URL"),
      accounts: [configVariable("HEMI_DEPLOYER_PRIVATE_KEY")],
    },
  },
});
