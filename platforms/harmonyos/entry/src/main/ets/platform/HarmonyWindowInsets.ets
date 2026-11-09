import { display, window } from '@kit.ArkUI';
import { deviceInfo } from '@kit.BasicServicesKit';
import { DeviceInsets, HarmonyHostRuntime } from './HarmonyNativeHost';

export class HarmonyWindowInsets {
  private mainWindow: window.Window | null;
  private readonly avoidAreaListener = (event: window.AvoidAreaOptions): void => {
    if (event.type === window.AvoidAreaType.TYPE_SYSTEM ||
      event.type === window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR ||
      event.type === window.AvoidAreaType.TYPE_CUTOUT) {
      this.refresh();
    }
  };
  private readonly sizeListener = (_size: window.Size): void => {
    this.refresh();
  };

  constructor(mainWindow: window.Window) {
    this.mainWindow = mainWindow;
    mainWindow.on('avoidAreaChange', this.avoidAreaListener);
    mainWindow.on('windowSizeChange', this.sizeListener);
  }

  async configure(): Promise<void> {
    const mainWindow = this.mainWindow;
    if (mainWindow === null) {
      return;
    }
    await mainWindow.setWindowLayoutFullScreen(true);
    // Window destruction can occur while the system applies layout changes.
    if (this.mainWindow === null) {
      return;
    }
    await this.setAppearance(false);
    this.refresh();
  }

  async setAppearance(dark: boolean): Promise<void> {
    const mainWindow = this.mainWindow;
    if (mainWindow === null) {
      throw new Error('当前窗口已关闭。');
    }
    // 2-in-1 windows do not support the system bar API.
    if (deviceInfo.deviceType === '2in1') {
      return;
    }
    const contentColor = dark ? '#D4D4D4' : '#000000';
    await mainWindow.setWindowSystemBarProperties({
      statusBarColor: '#00000000',
      navigationBarColor: '#00000000',
      statusBarContentColor: contentColor,
      navigationBarContentColor: contentColor
    });
  }

  private refresh(): void {
    const mainWindow = this.mainWindow;
    if (mainWindow === null) {
      return;
    }
    // Insets are needed before loadContent creates a UIContext. px / density = vp (CSS px).
    const density = display.getDisplayByIdSync(mainWindow.getWindowProperties().displayId as number).densityPixels;
    const insets: DeviceInsets = { top: 0, bottom: 0, left: 0, right: 0 };
    for (const type of [window.AvoidAreaType.TYPE_SYSTEM,
      window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR, window.AvoidAreaType.TYPE_CUTOUT]) {
      const area = mainWindow.getWindowAvoidArea(type);
      insets.top = Math.max(insets.top, area.topRect.height / density);
      insets.bottom = Math.max(insets.bottom, area.bottomRect.height / density);
      insets.left = Math.max(insets.left, area.leftRect.width / density);
      insets.right = Math.max(insets.right, area.rightRect.width / density);
    }
    HarmonyHostRuntime.setInsets(insets);
  }

  close(): void {
    const mainWindow = this.mainWindow;
    this.mainWindow = null;
    if (mainWindow !== null) {
      mainWindow.off('avoidAreaChange', this.avoidAreaListener);
      mainWindow.off('windowSizeChange', this.sizeListener);
    }
    HarmonyHostRuntime.setInsets({ top: 0, bottom: 0, left: 0, right: 0 });
  }
}
