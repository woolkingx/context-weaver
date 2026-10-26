// token_weight table of one cache database: source-backed capability projection.
export class TokenWeights {
  #db;

  #transaction;

  constructor({ db, transaction }) {
    this.#db = db;
    this.#transaction = transaction;
  }

  // The table is a projection of the token matrix: it is rewritten whole, so a changed or
  // deleted cell never survives in a persistent cache database.
  replace({ weights = [] } = {}) {
    this.#transaction(() => {
      this.#db.exec('DELETE FROM token_weight');
      const stmt = this.#db.prepare('INSERT OR IGNORE INTO token_weight (token_a, token_b, score) VALUES (?, ?, ?)');
      for (const weight of weights) stmt.run(weight.token_a, weight.token_b, weight.score);
    });
  }
}
