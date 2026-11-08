import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { NotesRepository } from '../data/NotesRepository';
import { HarmonyHostRuntime, HarmonyNativeHost } from '../platform/HarmonyNativeHost';

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController('insp-notes-web');
  private repository: NotesRepository | null = null;
  private nativeHost: HarmonyNativeHost | null = null;
  private blankLoaded: boolean = false;
  private proxyRegistered: boolean = false;

  aboutToAppear(): void {
    const context = getContext(this) as common.UIAbilityContext;
    this.openRepository(context);
  }

  private async openRepository(context: common.UIAbilityContext): Promise<void> {
    this.repository = await NotesRepository.open(context);
    this.tryLoadWebApp();
  }

  private tryLoadWebApp(): void {
    if (!this.blankLoaded || this.repository === null || this.proxyRegistered) {
      return;
    }
    this.nativeHost = new HarmonyNativeHost(this.repository, this.controller);
    this.controller.registerJavaScriptProxy(this.nativeHost, 'inspNative', ['postMessage']);
    HarmonyHostRuntime.attach(this.controller);
    this.proxyRegistered = true;
    this.controller.loadUrl('https://insp.local/index.html');
  }

  onBackPress(): boolean {
    if (this.proxyRegistered) {
      HarmonyHostRuntime.dispatchBack();
    } else {
      HarmonyHostRuntime.exitApp();
    }
    return true;
  }

  private interceptRequest(requestUrl: string): WebResourceResponse {
    if (requestUrl === 'about:blank') {
      return this.makeResponse(new ArrayBuffer(0), 'text/html', 200, 'OK');
    }
    const origin = 'https://insp.local';
    if (requestUrl !== origin && !requestUrl.startsWith(origin + '/')) {
      return this.makeResponse(new ArrayBuffer(0), 'text/plain', 403, 'Forbidden');
    }
    const pathStart = requestUrl.slice(origin.length).split('?')[0].split('#')[0];
    const path = decodeURIComponent(pathStart.length === 0 ? '/' : pathStart);
    if (path.startsWith('/attachments/')) {
      const fileName = path.slice('/attachments/'.length);
      try {
        const attachment = this.repository?.readAttachment(fileName);
        if (attachment !== undefined) {
          return this.makeResponse(attachment.bytes.buffer as ArrayBuffer, attachment.mimeType, 200, 'OK');
        }
      } catch (_error) {
        return this.makeResponse(new ArrayBuffer(0), 'text/plain', 404, 'Not Found');
      }
      return this.makeResponse(new ArrayBuffer(0), 'text/plain', 404, 'Not Found');
    }
    const rawPath = path === '/' ? 'web/index.html' : 'web' + path;
    if (rawPath.includes('..') || rawPath.includes('\\')) {
      return this.makeResponse(new ArrayBuffer(0), 'text/plain', 404, 'Not Found');
    }
    try {
      const bytes = getContext(this).resourceManager.getRawFileContentSync(rawPath);
      return this.makeResponse(bytes.buffer as ArrayBuffer, this.mimeType(rawPath), 200, 'OK');
    } catch (_error) {
      return this.makeResponse(new ArrayBuffer(0), 'text/plain', 404, 'Not Found');
    }
  }

  private mimeType(path: string): string {
    if (path.endsWith('.html')) return 'text/html';
    if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript';
    if (path.endsWith('.css')) return 'text/css';
    if (path.endsWith('.svg')) return 'image/svg+xml';
    if (path.endsWith('.png')) return 'image/png';
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
    if (path.endsWith('.gif')) return 'image/gif';
    if (path.endsWith('.webp')) return 'image/webp';
    if (path.endsWith('.woff2')) return 'font/woff2';
    if (path.endsWith('.json')) return 'application/json';
    if (path.endsWith('.ico')) return 'image/x-icon';
    return 'application/octet-stream';
  }

  private makeResponse(data: ArrayBuffer, mime: string, status: number, reason: string): WebResourceResponse {
    const response = new WebResourceResponse();
    response.setResponseData(data);
    response.setResponseMimeType(mime);
    response.setResponseEncoding('UTF-8');
    response.setResponseCode(status);
    response.setReasonMessage(reason);
    response.setResponseHeader([{ headerKey: 'Cache-Control', headerValue: 'no-store' }]);
    response.setResponseIsReady(true);
    return response;
  }

  build() {
    Column() {
      Web({ src: 'about:blank', controller: this.controller })
        .width('100%')
        .height('100%')
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .onPageBegin((event) => {
          if (event.url === 'about:blank') {
            this.blankLoaded = true;
            this.tryLoadWebApp();
          }
        })
        .onShowFileSelector(() => false)
        .onInterceptRequest((event) => this.interceptRequest(event.request.getRequestUrl()))
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F7F6F3')
  }
}
