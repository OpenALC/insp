import { common } from '@kit.AbilityKit';
import { systemShare } from '@kit.ShareKit';
import { uniformTypeDescriptor as utd } from '@kit.ArkData';
import { fileIo, fileUri, picker } from '@kit.CoreFileKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';

export interface ExportFileArgs {
  name: string;
  mimeType: string;
  base64: string;
}

export class ShareExport {
  private readonly context: common.UIAbilityContext;
  private readonly base64: util.Base64Helper = new util.Base64Helper();

  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  async shareText(text: string): Promise<void> {
    await pasteboard.getSystemPasteboard().setData(pasteboard.createPlainTextData(text));
    const data = new systemShare.SharedData({ utd: utd.UniformDataType.PLAIN_TEXT, content: text, title: '拾页笔记' });
    await new systemShare.ShareController(data).show(this.context, {
      selectionMode: systemShare.SelectionMode.SINGLE,
      previewMode: systemShare.SharePreviewMode.DEFAULT
    });
  }

  async shareFile(args: ExportFileArgs): Promise<void> {
    const name = args.name.replace(/[\\/]/g, '_');
    const path = this.context.cacheDir + '/' + name;
    this.write(path, this.base64.decodeSync(args.base64));
    const data = new systemShare.SharedData({
      utd: utd.UniformDataType.PNG,
      uri: fileUri.getUriFromPath(path),
      title: name
    });
    await new systemShare.ShareController(data).show(this.context, {
      selectionMode: systemShare.SelectionMode.SINGLE,
      previewMode: systemShare.SharePreviewMode.DEFAULT
    });
  }

  async saveFile(args: ExportFileArgs): Promise<boolean> {
    const name = args.name.replace(/[\\/]/g, '_');
    let uris: Array<string>;
    try {
      uris = await new picker.DocumentViewPicker(this.context).save({ newFileNames: [name] });
    } catch (_error) {
      return false;
    }
    if (uris.length === 0) return false;
    this.write(uris[0], this.base64.decodeSync(args.base64));
    return true;
  }

  private write(path: string, bytes: Uint8Array): void {
    const file = fileIo.openSync(path, fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC | fileIo.OpenMode.READ_WRITE);
    try {
      fileIo.writeSync(file.fd, bytes.buffer as ArrayBuffer);
    } finally {
      fileIo.closeSync(file.fd);
    }
  }
}
