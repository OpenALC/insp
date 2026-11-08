import { webview } from '@kit.ArkWeb';
import { NotesRepository, NoteKind, NoteWrite } from '../data/NotesRepository';

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

export interface BridgeResponse {
  id: string;
  result?: string;
  error?: string;
}

export class HarmonyNativeHost {
  private readonly repository: NotesRepository;
  private readonly controller: webview.WebviewController;

  constructor(repository: NotesRepository, controller: webview.WebviewController) {
    this.repository = repository;
    this.controller = controller;
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
      default:
        throw new Error('不支持的本地操作：' + request.command);
    }
    return JSON.stringify(result);
  }

  private respond(response: BridgeResponse): void {
    this.controller.runJavaScript(
      'window.__inspBridgeResponse(' + JSON.stringify(JSON.stringify(response)) + ')'
    );
  }
}

export class HarmonyHostRuntime {
  private static controller: webview.WebviewController | null = null;
  private static exitHandler: (() => void) | null = null;

  static attach(controller: webview.WebviewController): void {
    HarmonyHostRuntime.controller = controller;
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
