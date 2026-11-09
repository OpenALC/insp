import { webview } from '@kit.ArkWeb';
import { http } from '@kit.NetworkKit';
import { NotesRepository, NoteKind, NoteWrite, VaultCommitInput } from '../data/NotesRepository';
import { DeviceSecurity } from './DeviceSecurity';

interface BridgeRequest {
  id: string;
  command: string;
  args: Object;
}

interface CreateNoteArgs {
  groupId: string | null;
  kind?: NoteKind;
}

interface IdArgs {
  id: string;
}

interface SecretSetArgs {
  id: string;
  value: string;
}

interface AppearanceArgs {
  dark: boolean;
}

export interface DeviceInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface NameArgs {
  name: string;
}

interface RenameGroupArgs {
  id: string;
  name: string;
}

interface SaveNoteArgs {
  input: NoteWrite;
}

interface ImportImageArgs {
  originalName: string;
  bytes: number[];
}

interface VaultCommitArgs {
  input: VaultCommitInput;
}

interface SyncHttpArgs {
  url: string;
  method: string;
  token: string;
  body?: string;
}

interface SyncHttpRequest {
  input: SyncHttpArgs;
}

interface SyncHttpResponse {
  status: number;
  body: string;
}

export interface BridgeResponse {
  id: string;
  result?: string;
  error?: string;
}

export class HarmonyNativeHost {
  private readonly repository: NotesRepository;
  private readonly controller: webview.WebviewController;
  private readonly security: DeviceSecurity;
  private vaultQueue: Promise<void> = Promise.resolve();
  private disposed: boolean = false;

  constructor(repository: NotesRepository, controller: webview.WebviewController, security: DeviceSecurity) {
    this.repository = repository;
    this.controller = controller;
    this.security = security;
  }

  close(): void {
    this.disposed = true;
    this.security.close();
  }

  private enqueueVault<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.vaultQueue.then(() => action());
    this.vaultQueue = operation.then((): void => {}, (_error: Error): void => {});
    return operation;
  }

  postMessage(requestJson: string): void {
    const request = JSON.parse(requestJson) as BridgeRequest;
    if (request.command === 'exit_app') {
      HarmonyHostRuntime.exitApp();
      return;
    }
    this.dispatch(request).then((result: string): void => {
      this.respond({ id: request.id, result });
    }).catch((error: Error): void => {
      this.respond({ id: request.id, error: error.message });
    });
  }

  private async dispatch(request: BridgeRequest): Promise<string> {
    let result: Object | null = null;
    switch (request.command) {
      case 'device_secret_get':
        result = await this.security.getSecret((request.args as IdArgs).id);
        break;
      case 'device_secret_set': {
        const args = request.args as SecretSetArgs;
        await this.security.setSecret(args.id, args.value);
        break;
      }
      case 'device_auth_status':
        result = this.security.authStatus();
        break;
      case 'device_authenticate':
        result = await this.security.authenticate();
        break;
      case 'device_insets':
        result = HarmonyHostRuntime.getInsets();
        break;
      case 'device_set_appearance':
        await HarmonyHostRuntime.setAppearance((request.args as AppearanceArgs).dark);
        break;
      case 'load_workspace':
        result = await this.repository.loadWorkspace();
        break;
      case 'get_note':
        result = await this.repository.getNote((request.args as IdArgs).id);
        break;
      case 'create_note': {
        const args = request.args as CreateNoteArgs;
        result = await this.repository.createNote(args.groupId, args.kind ?? 'richtext');
        break;
      }
      case 'save_note':
        result = await this.repository.saveNote((request.args as SaveNoteArgs).input);
        break;
      case 'delete_note':
        await this.repository.deleteNote((request.args as IdArgs).id);
        break;
      case 'create_group':
        result = await this.repository.createGroup((request.args as NameArgs).name);
        break;
      case 'rename_group': {
        const args = request.args as RenameGroupArgs;
        result = await this.repository.renameGroup(args.id, args.name);
        break;
      }
      case 'delete_group':
        await this.repository.deleteGroup((request.args as IdArgs).id);
        break;
      case 'import_image': {
        const args = request.args as ImportImageArgs;
        result = await this.repository.importImage(args.originalName, args.bytes);
        break;
      }
      case 'resolve_image':
        result = await this.repository.resolveImage((request.args as IdArgs).id);
        break;
      case 'vault_header':
        result = await this.enqueueVault(() => this.repository.vaultHeader());
        break;
      case 'vault_list':
        result = await this.enqueueVault(() => this.repository.vaultList());
        break;
      case 'vault_get':
        result = await this.enqueueVault(() => this.repository.vaultGet((request.args as IdArgs).id));
        break;
      case 'vault_commit':
        await this.enqueueVault(() => this.repository.vaultCommit((request.args as VaultCommitArgs).input));
        break;
      case 'vault_legacy_export':
        result = await this.enqueueVault(() => this.repository.vaultLegacyExport());
        break;
      case 'sync_http':
        result = await this.syncHttp((request.args as SyncHttpRequest).input);
        break;
      default:
        throw new Error('不支持的本地操作：' + request.command);
    }
    return JSON.stringify(result);
  }

  private async syncHttp(input: SyncHttpArgs): Promise<SyncHttpResponse> {
    if (/[\u0000-\u0020\u007f]/.test(input.url)) {
      throw new Error('同步地址不能包含空白字符或控制字符。');
    }
    const urlMatch = /^(https?):\/\/([^/?#]+)(?:[/?#]|$)/i.exec(input.url);
    if (urlMatch === null) {
      throw new Error('同步地址必须使用 HTTPS，或使用受限的局域网 HTTP 地址。');
    }
    const protocol = urlMatch[1].toLowerCase() + ':';
    const authority = urlMatch[2];
    if (authority.includes('@')) {
      throw new Error('同步地址不能在 URL 中包含凭据。');
    }
    const authorityMatch = /^(?:\[([0-9a-f:.]+)\]|([^:]+))(?::([0-9]+))?$/i.exec(authority);
    if (authorityMatch === null) {
      throw new Error('同步地址格式无效。');
    }
    if (authorityMatch[3] !== undefined) {
      const port = Number(authorityMatch[3]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('同步地址端口无效。');
      }
    }
    let hostname: string;
    if (authorityMatch[1] !== undefined) {
      hostname = authorityMatch[1];
    } else {
      hostname = authorityMatch[2];
    }
    if (protocol === 'http:' && !this.isLocalHttpHost(hostname)) {
      throw new Error('明文 HTTP 仅允许 localhost 或局域网地址。');
    }

    const method = input.method.toUpperCase();
    const supportedMethods: string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
    if (!supportedMethods.includes(method)) {
      throw new Error('不支持的同步 HTTP 方法。');
    }

    const request = http.createHttp();
    const options: http.HttpRequestOptions = {
      method: method as http.RequestMethod,
      header: {
        'Authorization': 'Bearer ' + input.token,
        'Content-Type': 'application/json'
      },
      expectDataType: http.HttpDataType.STRING,
      connectTimeout: 30000,
      readTimeout: 60000,
      usingCache: false,
      maxRedirects: 0,
      maxLimit: 100 * 1024 * 1024,
      remoteValidation: 'system'
    };
    if (input.body !== undefined) {
      options.body = input.body;
    }
    try {
      const response = await request.request(input.url, options);
      return {
        status: response.responseCode,
        body: response.result as string
      };
    } finally {
      request.destroy();
    }
  }

  private isLocalHttpHost(hostname: string): boolean {
    let host = hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) {
      host = host.slice(1, host.length - 1);
    }
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
      return true;
    }
    if (host === '::1' || /^(fc|fd)[0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) {
      return true;
    }

    const octets = host.split('.');
    if (octets.length !== 4) {
      return false;
    }
    const address: number[] = [];
    for (const octet of octets) {
      if (!/^[0-9]{1,3}$/.test(octet)) {
        return false;
      }
      const value = Number(octet);
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        return false;
      }
      address.push(value);
    }
    return address[0] === 10 ||
      address[0] === 127 ||
      (address[0] === 169 && address[1] === 254) ||
      (address[0] === 172 && address[1] >= 16 && address[1] <= 31) ||
      (address[0] === 192 && address[1] === 168);
  }

  private respond(response: BridgeResponse): void {
    if (this.disposed) {
      return;
    }
    this.controller.runJavaScript(
      'window.__inspBridgeResponse(' + JSON.stringify(JSON.stringify(response)) + ')'
    );
  }
}

export class HarmonyHostRuntime {
  private static controller: webview.WebviewController | null = null;
  private static host: HarmonyNativeHost | null = null;
  private static pageReady: boolean = false;
  private static insets: DeviceInsets = { top: 0, bottom: 0, left: 0, right: 0 };
  private static exitHandler: (() => void) | null = null;
  private static appearanceHandler: ((dark: boolean) => Promise<void>) | null = null;

  static setAppearanceHandler(handler: ((dark: boolean) => Promise<void>) | null): void {
    HarmonyHostRuntime.appearanceHandler = handler;
  }

  static async setAppearance(dark: boolean): Promise<void> {
    const handler = HarmonyHostRuntime.appearanceHandler;
    if (handler === null) {
      throw new Error('当前窗口不可用。');
    }
    await handler(dark);
  }

  static attach(controller: webview.WebviewController, host: HarmonyNativeHost): void {
    HarmonyHostRuntime.controller = controller;
    HarmonyHostRuntime.host = host;
    HarmonyHostRuntime.pageReady = false;
  }

  static detach(controller?: webview.WebviewController): void {
    if (controller !== undefined && controller !== HarmonyHostRuntime.controller) {
      return;
    }
    HarmonyHostRuntime.controller = null;
    HarmonyHostRuntime.pageReady = false;
    const host = HarmonyHostRuntime.host;
    HarmonyHostRuntime.host = null;
    if (host !== null) {
      host.close();
    }
  }

  static getInsets(): DeviceInsets {
    return HarmonyHostRuntime.insets;
  }

  static setInsets(insets: DeviceInsets): void {
    HarmonyHostRuntime.insets = insets;
    HarmonyHostRuntime.publishInsets();
  }

  static markPageReady(): void {
    HarmonyHostRuntime.pageReady = true;
    HarmonyHostRuntime.publishInsets();
  }

  private static publishInsets(): void {
    if (HarmonyHostRuntime.controller !== null && HarmonyHostRuntime.pageReady) {
      HarmonyHostRuntime.controller.runJavaScript(
        "window.dispatchEvent(new CustomEvent('insp:insets', { detail: " + JSON.stringify(HarmonyHostRuntime.insets) + ' }))'
      );
    }
  }

  static clearExitHandler(): void {
    HarmonyHostRuntime.exitHandler = null;
  }

  static setExitHandler(exitHandler: () => void): void {
    HarmonyHostRuntime.exitHandler = exitHandler;
  }

  static dispatchBack(): void {
    if (HarmonyHostRuntime.controller !== null) {
      HarmonyHostRuntime.controller.runJavaScript(
        "(async () => { if (!window.inspNative) return; const event = new Event('insp:back', { cancelable: true }); window.dispatchEvent(event); if (!event.defaultPrevented) { const canClose = window.__inspBeforeClose ? await window.__inspBeforeClose() : true; if (canClose) window.inspNative.postMessage(JSON.stringify({ id: 'native-back', command: 'exit_app', args: {} })); } })()"
      );
    }
  }

  static exitApp(): void {
    if (HarmonyHostRuntime.exitHandler !== null) {
      HarmonyHostRuntime.exitHandler();
    }
  }

  static flushBeforeBackground(): void {
    if (HarmonyHostRuntime.controller !== null) {
      HarmonyHostRuntime.controller.runJavaScript('window.__inspBeforeClose ? window.__inspBeforeClose() : true');
    }
  }
}
