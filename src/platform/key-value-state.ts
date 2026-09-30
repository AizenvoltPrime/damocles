export interface Memento {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Promise<void>;
}

export interface KeyValueState {
  readonly global: Memento;
  readonly workspace: Memento;
}
