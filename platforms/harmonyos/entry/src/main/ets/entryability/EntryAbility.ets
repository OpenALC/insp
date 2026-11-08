import { UIAbility, Want, AbilityConstant } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { HarmonyHostRuntime } from '../platform/HarmonyNativeHost';

export default class EntryAbility extends UIAbility {
  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    HarmonyHostRuntime.setExitHandler((): void => {
      this.context.terminateSelf();
    });
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index');
  }

  onBackground(): void {
    HarmonyHostRuntime.flushBeforeBackground();
  }

}
