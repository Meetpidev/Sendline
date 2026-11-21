import { useState, type FormEvent } from 'react';
import {
  AlertCircle,
  Database,
  Lock,
  Mail,
  RefreshCw,
  ShieldCheck,
  User,
} from 'lucide-react';
import { api } from '../api/client';
import type { AuthUser } from '../types';

interface AuthViewProps {
  databaseConfigured: boolean;
  databaseReady: boolean;
  databaseError: string | null;
  onAuthenticated: (user: AuthUser) => void;
  onRetryConnection: () => Promise<void>;
}

export function AuthView({
  databaseConfigured,
  databaseReady,
  databaseError,
  onAuthenticated,
  onRetryConnection,
}: AuthViewProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [checkingDb, setCheckingDb] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res =
        mode === 'register'
          ? await api.register({ name, email, password })
          : await api.login({ email, password });
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCheckDatabase() {
    setCheckingDb(true);
    try {
      await onRetryConnection();
    } finally {
      setCheckingDb(false);
    }
  }

  if (!databaseConfigured || !databaseReady) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-6">
        <div className="w-full max-w-lg bg-white border border-slate-200 rounded-lg p-8 space-y-6">
          <div className="space-y-2">
            <div className="font-display text-xl font-bold tracking-tight text-slate-900">
              Sendline
            </div>
            <h1 className="font-display text-lg font-semibold text-slate-900 flex items-center gap-2">
              <Database className="h-5 w-5 text-emerald-700 shrink-0" />
              Connect Your Neon PostgreSQL Database
            </h1>
            <p className="text-sm text-slate-600 leading-relaxed">
              Sendline stores all campaigns, contact lists, PDF/image attachments, poll
              results, and per-user WhatsApp sessions permanently in PostgreSQL so your
              data never disappears.
            </p>
          </div>

          {databaseError && (
            <div className="p-3.5 rounded-md bg-red-50 border border-red-200 text-xs text-red-800 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{databaseError}</span>
            </div>
          )}

          <div className="bg-slate-50 border border-slate-200 rounded-md p-4 space-y-2.5 text-xs text-slate-700">
            <div className="font-semibold text-slate-900">
              One-time setup (takes 10 seconds):
            </div>
            <ol className="list-decimal list-inside space-y-1.5 leading-relaxed">
              <li>
                Open <strong>Settings → Secrets</strong> in the AI Studio toolbar.
              </li>
              <li>
                Add a secret named{' '}
                <code className="font-mono bg-white px-1.5 py-0.5 rounded border border-slate-200 text-slate-900">
                  DATABASE_URL
                </code>{' '}
                with your Neon PostgreSQL connection string.
              </li>
              <li>Save the secret and click Check Connection below.</li>
            </ol>
          </div>

          <button
            type="button"
            disabled={checkingDb}
            onClick={() => void handleCheckDatabase()}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${checkingDb ? 'animate-spin' : ''}`} />
            {checkingDb ? 'Checking Database...' : 'Check Database Connection'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-1.5">
          <div className="font-display text-2xl font-bold tracking-tight text-slate-900">
            Sendline
          </div>
          <p className="text-sm text-slate-500">
            Private WhatsApp broadcast workspace
          </p>
        </div>

        <section className="bg-white border border-slate-200 rounded-lg p-7 space-y-6">
          <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-md">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setError(null);
              }}
              className={`py-2 text-xs font-semibold rounded transition-colors ${
                mode === 'login'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('register');
                setError(null);
              }}
              className={`py-2 text-xs font-semibold rounded transition-colors ${
                mode === 'register'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Create Account
            </button>
          </div>

          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            {mode === 'register' && (
              <div className="space-y-1.5">
                <label
                  htmlFor="auth-name"
                  className="block text-xs font-medium text-slate-700"
                >
                  Your Name
                </label>
                <div className="relative">
                  <User className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="auth-name"
                    type="text"
                    required
                    minLength={2}
                    maxLength={80}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Harshal Maniar"
                    className="w-full h-10 rounded-md border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/15"
                  />
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label
                htmlFor="auth-email"
                className="block text-xs font-medium text-slate-700"
              >
                Email Address
              </label>
              <div className="relative">
                <Mail className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="auth-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="w-full h-10 rounded-md border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/15"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="auth-password"
                className="block text-xs font-medium text-slate-700"
              >
                Password
              </label>
              <div className="relative">
                <Lock className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="auth-password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete={
                    mode === 'register' ? 'new-password' : 'current-password'
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className="w-full h-10 rounded-md border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/15"
                />
              </div>
            </div>

            {error && (
              <div
                role="alert"
                className="p-3 rounded-md bg-red-50 border border-red-200 text-xs text-red-700 flex items-start gap-2"
              >
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full h-10 inline-flex items-center justify-center text-sm font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md transition-colors disabled:opacity-50"
            >
              {submitting
                ? mode === 'register'
                  ? 'Creating Private Workspace...'
                  : 'Signing In...'
                : mode === 'register'
                  ? 'Create Private Workspace'
                  : 'Sign In to Workspace'}
            </button>
          </form>

          <div className="pt-4 border-t border-slate-200 flex items-start gap-2.5 text-xs text-slate-500">
            <ShieldCheck className="h-4 w-4 text-emerald-700 shrink-0 mt-0.5" />
            <span>
              Every account gets an isolated Sendline project. Your campaigns, contacts,
              attachments, poll results, and linked WhatsApp device are strictly private
              to your login and saved permanently.
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
