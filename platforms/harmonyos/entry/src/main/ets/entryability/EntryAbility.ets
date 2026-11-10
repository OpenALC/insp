import { UIAbility, Want, AbilityConstant } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { HarmonyHostRuntime } from '../platform/HarmonyNativeHost';
import { HarmonyWindowInsets } from '../platform/HarmonyWindowInsets';

export default class EntryAbility extends UIAbility {
  private windowInsets: HarmonyWindowInsets | null = null;
  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    HarmonyHostRuntime.setExitHandler((): void => {
      this.context.moveAbilityToBackground();
    });
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    const insets = new HarmonyWindowInsets(windowStage.getMainWindowSync());
    this.windowInsets = insets;
    HarmonyHostRuntime.setAppearanceHandler((dark: boolean): Promise<void> => insets.setAppearance(dark));
    insets.configure().then((): void => {
      if (this.windowInsets === insets) {
        windowStage.loadContent('pages/Index');
      }
    });
  }

  onWindowStageDestroy(): void {
    HarmonyHostRuntime.setAppearanceHandler(null);
    HarmonyHostRuntime.detach();
    if (this.windowInsets !== null) {
      this.windowInsets.close();
      this.windowInsets = null;
    }
  }

  onDestroy(): void {
    HarmonyHostRuntime.clearExitHandler();
  }

  onBackground(): void {
    HarmonyHostRuntime.flushBeforeBackground();
  }

}
