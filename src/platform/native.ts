export type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>
