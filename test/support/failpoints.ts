export class Failpoints {
  private armed?: string;

  arm(name: string): void {
    this.armed = name;
  }

  hit(name: string): void {
    if (this.armed !== name) return;
    throw new Error(`Injected failure at ${name}`);
  }
}
