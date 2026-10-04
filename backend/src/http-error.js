/** Erreur "attendue" avec un code HTTP : son message est sûr à renvoyer tel quel au client. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}
