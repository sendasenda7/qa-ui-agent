import { useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { login } from "../lib/api.js";

export default function Login({ onSuccess }) {
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      await login(password);
      onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg text-text flex items-center justify-center px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-surface border border-border rounded-2xl p-6 flex flex-col gap-4"
      >
        <div className="flex flex-col items-center gap-2 mb-2">
          <span className="gradient-accent w-12 h-12 rounded-full flex items-center justify-center">
            <Lock size={20} className="text-white" />
          </span>
          <h1 className="text-lg font-semibold">QA-UI Agent</h1>
          <p className="text-sm text-text-muted text-center">
            Mot de passe d'équipe requis pour accéder à l'outil.
          </p>
        </div>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Mot de passe"
          autoFocus
          className="bg-surface-raised border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-blue"
        />

        {error && <p className="text-sm text-danger">{error}</p>}

        <button
          type="submit"
          disabled={!password || isLoading}
          className="gradient-accent rounded-lg py-2 text-white text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2"
        >
          {isLoading && <Loader2 size={14} className="animate-spin" />}
          {isLoading ? "Connexion..." : "Se connecter"}
        </button>
      </form>
    </div>
  );
}
