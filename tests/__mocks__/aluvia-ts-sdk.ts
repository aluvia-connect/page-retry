export default class Aluvia {
  constructor(public apiKey: string) {}
  async first() {
    return {
      host: "127.0.0.1",
      httpPort: 8080,
      username: "user",
      password: "pass",
    };
  }
}
