import { delay, inject, singleton } from 'tsyringe';
import { TYPES } from '../types';

import {
  Key,
  KeyRing,
  KeyRingStatus,
  MultiKeyStoreInfoWithSelected
} from './keyring';

import {
  Bech32Address,
  checkAndValidateADR36AminoSignDoc,
  makeADR36AminoSignDoc,
  verifyADR36AminoSignDoc
} from '@owallet/cosmos';
import {
  BIP44HDPath,
  CommonCrypto,
  ECDSASignature,
  ExportKeyRingData,
  MessageTypes,
  SignEthereumTypedDataObject,
  SignTypedDataVersion,
  TypedMessage
} from './types';

import { KVStore } from '@owallet/common';

import { ChainsService } from '../chains';
import { LedgerService } from '../ledger';
import { BIP44, ChainInfo, OWalletSignOptions } from '@owallet/types';
import { APP_PORT, Env, OWalletError, WEBPAGE_PORT } from '@owallet/router';
import { InteractionService } from '../interaction';
import { PermissionService } from '../permission';

import {
  encodeSecp256k1Signature,
  serializeSignDoc,
  AminoSignResponse,
  StdSignDoc,
  StdSignature
} from '@cosmjs/launchpad';
import { DirectSignResponse, makeSignBytes } from '@cosmjs/proto-signing';

import { RNG } from '@owallet/crypto';
import { cosmos } from '@owallet/cosmos';
import { Buffer } from 'buffer/';
import { request } from '../tx';

@singleton()
export class KeyRingService {
  private readonly keyRing: KeyRing;

  constructor(
    @inject(TYPES.KeyRingStore)
    kvStore: KVStore,
    @inject(TYPES.ChainsEmbedChainInfos)
    embedChainInfos: ChainInfo[],
    @inject(delay(() => InteractionService))
    protected readonly interactionService: InteractionService,
    @inject(delay(() => ChainsService))
    public readonly chainsService: ChainsService,
    @inject(delay(() => PermissionService))
    public readonly permissionService: PermissionService,
    @inject(LedgerService)
    ledgerService: LedgerService,
    @inject(TYPES.RNG)
    protected readonly rng: RNG,
    @inject(TYPES.CommonCrypto)
    protected readonly crypto: CommonCrypto
  ) {
    this.keyRing = new KeyRing(
      embedChainInfos,
      kvStore,
      ledgerService,
      rng,
      crypto
    );
  }

  async restore(): Promise<{
    status: KeyRingStatus;
    multiKeyStoreInfo: MultiKeyStoreInfoWithSelected;
  }> {
    await this.keyRing.restore();
    return {
      status: this.keyRing.status,
      multiKeyStoreInfo: this.keyRing.getMultiKeyStoreInfo()
    };
  }

  async enable(env: Env): Promise<KeyRingStatus> {
    if (this.keyRing.status === KeyRingStatus.EMPTY) {
      throw new OWalletError('keyring', 261, "key doesn't exist");
    }

    if (this.keyRing.status === KeyRingStatus.NOTLOADED) {
      await this.keyRing.restore();
    }

    if (this.keyRing.status === KeyRingStatus.LOCKED) {
      await this.interactionService.waitApprove(env, '/unlock', 'unlock', {});
      return this.keyRing.status;
    }

    return this.keyRing.status;
  }

  get keyRingStatus(): KeyRingStatus {
    return this.keyRing.status;
  }

  async deleteKeyRing(
    index: number,
    password: string
  ): Promise<{
    multiKeyStoreInfo: MultiKeyStoreInfoWithSelected;
    status: KeyRingStatus;
  }> {
    let keyStoreChanged = false;

    try {
      const result = await this.keyRing.deleteKeyRing(index, password);
      keyStoreChanged = result.keyStoreChanged;
      return {
        multiKeyStoreInfo: result.multiKeyStoreInfo,
        status: this.keyRing.status
      };
    } finally {
      if (keyStoreChanged) {
        this.interactionService.dispatchEvent(
          WEBPAGE_PORT,
          'keystore-changed',
          {}
        );
      }
    }
  }

  async updateNameKeyRing(
    index: number,
    name: string
  ): Promise<{
    multiKeyStoreInfo: MultiKeyStoreInfoWithSelected;
  }> {
    const multiKeyStoreInfo = await this.keyRing.updateNameKeyRing(index, name);
    return {
      multiKeyStoreInfo
    };
  }

  async showKeyRing(index: number, password: string): Promise<string> {
    return await this.keyRing.showKeyRing(index, password);
  }

  async createMnemonicKey(
    kdf: 'scrypt' | 'sha256' | 'pbkdf2',
    mnemonic: string,
    password: string,
    meta: Record<string, string>,
    bip44HDPath: BIP44HDPath
  ): Promise<{
    status: KeyRingStatus;
    multiKeyStoreInfo: MultiKeyStoreInfoWithSelected;
  }> {
    // TODO: Check mnemonic checksum.
    return await this.keyRing.createMnemonicKey(
      kdf,
      mnemonic,
      password,
      meta,
      bip44HDPath
    );
  }

  async createPrivateKey(
    kdf: 'scrypt' | 'sha256' | 'pbkdf2',
    privateKey: Uint8Array,
    password: string,
    meta: Record<string, string>
  ): Promise<{
    status: KeyRingStatus;
    multiKeyStoreInfo: MultiKeyStoreInfoWithSelected;
  }> {
    return await this.keyRing.createPrivateKey(kdf, privateKey, password, meta);
  }

  async createLedgerKey(
    env: Env,
    kdf: 'scrypt' | 'sha256' | 'pbkdf2',
    password: string,
    meta: Record<string, string>,
    bip44HDPath: BIP44HDPath
  ): Promise<{
    status: KeyRingStatus;
    multiKeyStoreInfo: MultiKeyStoreInfoWithSelected;
  }> {
    return await this.keyRing.createLedgerKey(
      env,
      kdf,
      password,
      meta,
      bip44HDPath
    );
  }

  lock(): KeyRingStatus {
    this.keyRing.lock();
    return this.keyRing.status;
  }

  async unlock(password: string): Promise<KeyRingStatus> {
    await this.keyRing.unlock(password);

    return this.keyRing.status;
  }

  async getKey(chainIdOrCoinType: string | number): Promise<Key> {
    // if getKey directly from cointype as number
    if (typeof chainIdOrCoinType === 'number') {
      return this.keyRing.getKeyFromCoinType(chainIdOrCoinType);
    }
    return this.keyRing.getKey(
      chainIdOrCoinType,
      await this.chainsService.getChainCoinType(chainIdOrCoinType)
    );
  }

  getKeyStoreMeta(key: string): string {
    return this.keyRing.getKeyStoreMeta(key);
  }

  getKeyRingType(): string {
    return this.keyRing.type;
  }

  async requestSignAmino(
    env: Env,
    msgOrigin: string,
    chainId: string,
    signer: string,
    signDoc: StdSignDoc,
    signOptions: OWalletSignOptions & {
      // Hack option field to detect the sign arbitrary for string
      isADR36WithString?: boolean;
    }
  ): Promise<AminoSignResponse> {
    const coinType = await this.chainsService.getChainCoinType(chainId);

    const key = this.keyRing.getKey(chainId, coinType);
    const bech32Prefix = (await this.chainsService.getChainInfo(chainId))
      .bech32Config.bech32PrefixAccAddr;
    const bech32Address = new Bech32Address(key.address).toBech32(bech32Prefix);
    if (signer !== bech32Address) {
      throw new Error('Signer mismatched');
    }

    const isADR36SignDoc = checkAndValidateADR36AminoSignDoc(
      signDoc,
      bech32Prefix
    );
    if (isADR36SignDoc) {
      if (signDoc.msgs[0].value.signer !== signer) {
        throw new OWalletError('keyring', 233, 'Unmatched signer in sign doc');
      }
    }

    if (signOptions.isADR36WithString != null && !isADR36SignDoc) {
      throw new OWalletError(
        'keyring',
        236,
        'Sign doc is not for ADR-36. But, "isADR36WithString" option is defined'
      );
    }

    const newSignDoc = (await this.interactionService.waitApprove(
      env,
      '/sign',
      'request-sign',
      {
        msgOrigin,
        chainId,
        mode: 'amino',
        signDoc,
        signer,
        signOptions,
        isADR36SignDoc,
        isADR36WithString: signOptions.isADR36WithString
      }
    )) as StdSignDoc;

    if (isADR36SignDoc) {
      // Validate the new sign doc, if it was for ADR-36.
      if (checkAndValidateADR36AminoSignDoc(signDoc, bech32Prefix)) {
        if (signDoc.msgs[0].value.signer !== signer) {
          throw new OWalletError(
            'keyring',
            232,
            'Unmatched signer in new sign doc'
          );
        }
      } else {
        throw new OWalletError(
          'keyring',
          237,
          'Signing request was for ADR-36. But, accidentally, new sign doc is not for ADR-36'
        );
      }
    }

    try {
      const signature = await this.keyRing.sign(
        env,
        chainId,
        coinType,
        serializeSignDoc(newSignDoc)
      );

      return {
        signed: newSignDoc,
        signature: encodeSecp256k1Signature(key.pubKey, signature)
      };
    } finally {
      this.interactionService.dispatchEvent(APP_PORT, 'request-sign-end', {});
    }
  }

  async requestSignDirect(
    env: Env,
    msgOrigin: string,
    chainId: string,
    signer: string,
    signDoc: cosmos.tx.v1beta1.SignDoc,
    signOptions: OWalletSignOptions
  ): Promise<DirectSignResponse> {
    const coinType = await this.chainsService.getChainCoinType(chainId);

    const key = this.keyRing.getKey(chainId, coinType);
    const bech32Address = new Bech32Address(key.address).toBech32(
      (await this.chainsService.getChainInfo(chainId)).bech32Config
        .bech32PrefixAccAddr
    );
    if (signer !== bech32Address) {
      throw new Error('Signer mismatched');
    }

    const newSignDocBytes = (await this.interactionService.waitApprove(
      env,
      '/sign',
      'request-sign',
      {
        msgOrigin,
        chainId,
        mode: 'direct',
        signDocBytes: cosmos.tx.v1beta1.SignDoc.encode(signDoc).finish(),
        signer,
        signOptions
      }
    )) as Uint8Array;

    const newSignDoc = cosmos.tx.v1beta1.SignDoc.decode(newSignDocBytes);

    try {
      const signature = await this.keyRing.sign(
        env,
        chainId,
        coinType,
        makeSignBytes(newSignDoc)
      );

      return {
        signed: newSignDoc,
        signature: encodeSecp256k1Signature(key.pubKey, signature)
      };
    } catch (e) {
      console.log('e', e.message);
    } finally {
      this.interactionService.dispatchEvent(APP_PORT, 'request-sign-end', {});
    }
  }

  async requestSignEthereum(
    env: Env,
    chainId: string,
    data: object
  ): Promise<string> {
    const coinType = await this.chainsService.getChainCoinType(chainId);
    const rpc = (await this.chainsService.getChainInfo(chainId)).rest;

    console.log(data, 'DATA IN HEREEEEEEEEEEEEEEEEEEEEEEEE');

    // TODO: add UI here so users can change gas, memo & fee
    const newData = await this.estimateFeeAndWaitApprove(
      env,
      chainId,
      rpc,
      data
    );

    try {
      const rawTxHex = await this.keyRing.signAndBroadcastEthereum(
        chainId,
        coinType,
        rpc,
        newData
      );

      return rawTxHex;
    } finally {
      this.interactionService.dispatchEvent(
        APP_PORT,
        'request-sign-ethereum-end',
        {}
      );
    }
  }

  async requestSignEthereumTypedData(
    env: Env,
    chainId: string,
    data: SignEthereumTypedDataObject
  ): Promise<ECDSASignature> {
    console.log('in request sign ethereum typed data: ', chainId, data);

    try {
      const rawTxHex = await this.keyRing.signEthereumTypedData({
        typedMessage: data.typedMessage,
        version: data.version,
        chainId,
        defaultCoinType: data.defaultCoinType
      });

      return rawTxHex;
    } catch (e) {
      console.log('e', e.message);
    } finally {
      this.interactionService.dispatchEvent(APP_PORT, 'request-sign-end', {});
    }
  }

  async requestPublicKey(env: Env, chainId: string): Promise<string> {
    console.log('in request sign proxy re-encryption data: ', chainId);

    try {
      const rawTxHex = await this.keyRing.getPublicKey(chainId);

      return rawTxHex;
    } catch (e) {
      console.log('e', e.message);
    } finally {
      this.interactionService.dispatchEvent(
        APP_PORT,
        'request-sign-ethereum-end',
        {}
      );
    }
  }

  async requestSignProxyDecryptionData(
    env: Env,
    chainId: string,
    data: object
  ): Promise<object> {
    console.log('in request sign proxy decryption data: ', chainId);

    try {
      const rpc = (await this.chainsService.getChainInfo(chainId)).rest;
      const newData = await this.estimateFeeAndWaitApprove(
        env,
        chainId,
        rpc,
        data
      );
      const rawTxHex = await this.keyRing.signProxyDecryptionData(
        chainId,
        newData
      );

      return rawTxHex;
    } catch (e) {
      console.log('e', e.message);
    } finally {
      this.interactionService.dispatchEvent(
        APP_PORT,
        'request-sign-ethereum-end',
        {}
      );
    }
  }

  // thang6
  async requestSignProxyReEncryptionData(
    env: Env,
    chainId: string,
    data: object
  ): Promise<object> {
    console.log('in request sign proxy re-encryption data: ', chainId);

    try {
      const rpc = (await this.chainsService.getChainInfo(chainId)).rest;
      const newData = await this.estimateFeeAndWaitApprove(
        env,
        chainId,
        rpc,
        data
      );
      const rawTxHex = await this.keyRing.signProxyReEncryptionData(
        chainId,
        newData
      );

      return rawTxHex;
    } catch (e) {
      console.log('e', e.message);
    } finally {
      this.interactionService.dispatchEvent(
        APP_PORT,
        'request-sign-ethereum-end',
        {}
      );
    }
  }

  async estimateFeeAndWaitApprove(
    env: Env,
    chainId: string,
    rpc: string,
    data: object
  ): Promise<object> {
    const decimals = (await this.chainsService.getChainInfo(chainId))
      .feeCurrencies?.[0].coinDecimals;
    const estimatedGasPrice = await request(rpc, 'eth_gasPrice', []);
    var estimatedGasLimit = '0x5028';
    try {
      estimatedGasLimit = await request(rpc, 'eth_estimateGas', [
        {
          ...data,
          maxFeePerGas: undefined,
          maxPriorityFeePerGas: undefined
        }
      ]);
    } catch (error) {
      console.log(
        '🚀 ~ file: service.ts ~ line 396 ~ KeyRingService ~ error',
        error
      );
    }

    console.log(
      '🚀 ~ file: service.ts ~ line 389 ~ KeyRingService ~ estimatedGasPrice',
      estimatedGasPrice
    );
    console.log(
      '🚀 ~ file: service.ts ~ line 392 ~ KeyRingService ~ estimatedGasLimit',
      estimatedGasLimit
    );

    const approveData = (await this.interactionService.waitApprove(
      env,
      '/sign',
      'request-sign-ethereum',
      {
        env,
        chainId,
        mode: 'direct',
        data: {
          ...data,
          estimatedGasPrice: (data as any)?.gasPrice || estimatedGasPrice,
          estimatedGasLimit: (data as any)?.gas || estimatedGasLimit,
          decimals
        }
      }
    )) as any;

    const { gasPrice, gasLimit, memo, fees } = {
      gasPrice: approveData.gasPrice ?? '0x0',
      memo: approveData.memo ?? '',
      gasLimit: approveData.gasLimit,
      fees: approveData.fees
    };

    return { ...data, gasPrice, gasLimit, memo, fees };
  }

  async verifyADR36AminoSignDoc(
    chainId: string,
    signer: string,
    data: Uint8Array,
    signature: StdSignature
  ): Promise<boolean> {
    const coinType = await this.chainsService.getChainCoinType(chainId);

    const key = this.keyRing.getKey(chainId, coinType);
    const bech32Prefix = (await this.chainsService.getChainInfo(chainId))
      .bech32Config.bech32PrefixAccAddr;
    const bech32Address = new Bech32Address(key.address).toBech32(bech32Prefix);
    if (signer !== bech32Address) {
      throw new Error('Signer mismatched');
    }
    if (signature.pub_key.type !== 'tendermint/PubKeySecp256k1') {
      throw new Error(`Unsupported type of pub key: ${signature.pub_key.type}`);
    }
    if (
      Buffer.from(key.pubKey).toString('base64') !== signature.pub_key.value
    ) {
      throw new Error('Pub key unmatched');
    }

    const signDoc = makeADR36AminoSignDoc(signer, data);

    return verifyADR36AminoSignDoc(
      bech32Prefix,
      signDoc,
      Buffer.from(signature.pub_key.value, 'base64'),
      Buffer.from(signature.signature, 'base64')
    );
  }

  // here
  async sign(
    env: Env,
    chainId: string,
    message: Uint8Array
  ): Promise<Uint8Array> {
    return this.keyRing.sign(
      env,
      chainId,
      await this.chainsService.getChainCoinType(chainId),
      message
    );
  }

  async addMnemonicKey(
    kdf: 'scrypt' | 'sha256' | 'pbkdf2',
    mnemonic: string,
    meta: Record<string, string>,
    bip44HDPath: BIP44HDPath
  ): Promise<{
    multiKeyStoreInfo: MultiKeyStoreInfoWithSelected;
  }> {
    return this.keyRing.addMnemonicKey(kdf, mnemonic, meta, bip44HDPath);
  }

  async addPrivateKey(
    kdf: 'scrypt' | 'sha256' | 'pbkdf2',
    privateKey: Uint8Array,
    meta: Record<string, string>
  ): Promise<{
    multiKeyStoreInfo: MultiKeyStoreInfoWithSelected;
  }> {
    return this.keyRing.addPrivateKey(kdf, privateKey, meta);
  }

  async addLedgerKey(
    env: Env,
    kdf: 'scrypt' | 'sha256' | 'pbkdf2',
    meta: Record<string, string>,
    bip44HDPath: BIP44HDPath
  ): Promise<{
    multiKeyStoreInfo: MultiKeyStoreInfoWithSelected;
  }> {
    return this.keyRing.addLedgerKey(env, kdf, meta, bip44HDPath);
  }

  public async changeKeyStoreFromMultiKeyStore(index: number): Promise<{
    multiKeyStoreInfo: MultiKeyStoreInfoWithSelected;
  }> {
    try {
      return await this.keyRing.changeKeyStoreFromMultiKeyStore(index);
    } finally {
      this.interactionService.dispatchEvent(
        WEBPAGE_PORT,
        'keystore-changed',
        {}
      );
    }
  }

  public async changeChain(chainInfos: object = {}) {
    console.log('changeChain stores core', chainInfos);
    this.interactionService.dispatchEvent(WEBPAGE_PORT, 'keystore-changed', {
      ...chainInfos
    });
  }

  public checkPassword(password: string): boolean {
    return this.keyRing.checkPassword(password);
  }

  getMultiKeyStoreInfo(): MultiKeyStoreInfoWithSelected {
    return this.keyRing.getMultiKeyStoreInfo();
  }

  isKeyStoreCoinTypeSet(chainId: string): boolean {
    return this.keyRing.isKeyStoreCoinTypeSet(chainId);
  }

  async setKeyStoreCoinType(chainId: string, coinType: number): Promise<void> {
    const prevCoinType = this.keyRing.computeKeyStoreCoinType(
      chainId,
      await this.chainsService.getChainCoinType(chainId)
    );

    await this.keyRing.setKeyStoreCoinType(chainId, coinType);

    if (prevCoinType !== coinType) {
      this.interactionService.dispatchEvent(
        WEBPAGE_PORT,
        'keystore-changed',
        {}
      );
    }
  }

  async getKeyStoreBIP44Selectables(
    chainId: string,
    paths: BIP44[]
  ): Promise<{ readonly path: BIP44; readonly bech32Address: string }[]> {
    if (this.isKeyStoreCoinTypeSet(chainId)) {
      return [];
    }

    const result = [];
    const chainInfo = await this.chainsService.getChainInfo(chainId);

    for (const path of paths) {
      const key = this.keyRing.getKeyFromCoinType(path.coinType);
      const bech32Address = new Bech32Address(key.address).toBech32(
        chainInfo.bech32Config.bech32PrefixAccAddr
      );

      result.push({
        path,
        bech32Address
      });
    }

    return result;
  }

  async exportKeyRingDatas(password: string): Promise<ExportKeyRingData[]> {
    return await this.keyRing.exportKeyRingDatas(password);
  }
}
