import type { ReactNode } from "react";
import type { AppSettings } from "../../services/api";
import { Skeleton } from "../../components/ui";
import { buddyPref, useBuddyEnabled } from "../../components/CursorBuddy";

const Code = ({ children }: { children: ReactNode }) => <code className="rounded bg-paper px-1.5 py-0.5 text-[0.92em] ring-1 ring-rule">{children}</code>;

function Group({ title, rows, note }: { title: string; rows: [string, ReactNode][]; note?: ReactNode }) {
  return (
    <section>
      <h2 className="font-semibold">{title}</h2>
      <dl className="mt-3 divide-y divide-rule border-y border-rule text-[15px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-6 py-2.5">
            <dt className="text-graphite">{k}</dt>
            <dd className="text-right break-all">{v}</dd>
          </div>
        ))}
      </dl>
      {note && <p className="mt-3 text-sm leading-relaxed text-graphite">{note}</p>}
    </section>
  );
}

function BuddyToggle() {
  const on = useBuddyEnabled();
  return (
    <section>
      <h2 className="font-semibold">Appearance</h2>
      <label className="mt-3 flex cursor-pointer items-center justify-between gap-6 border-y border-rule py-3 text-[15px]">
        <span>
          Cursor buddy
          <span className="block text-sm text-graphite">A small robot that follows your mouse. Hidden on touch screens and with reduced motion.</span>
        </span>
        <input type="checkbox" role="switch" checked={on} onChange={(e) => buddyPref.set(e.target.checked)} className="peer sr-only" />
        <span aria-hidden className="relative h-6 w-11 shrink-0 rounded-full bg-rule transition-colors peer-checked:bg-bridge peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-bridge after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5" />
      </label>
    </section>
  );
}

export function SettingsPage({ settings, error }: { settings: AppSettings | null; error: string | null }) {
  return (
    <div>
      <h1 className="text-3xl font-medium tracking-[-0.02em]">Settings & help</h1>
      <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-graphite">
        These values come from <Code>backend/.env</Code> and are read-only here. API keys never leave the server.
      </p>
      {error && <p className="mt-6 text-[15px] text-red-700">{error}</p>}

      <div className="mt-10 grid gap-x-14 gap-y-12 lg:grid-cols-2">
        {!settings ? (
          !error &&
          [0, 1].map((i) => (
            <div key={i} className="space-y-3">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-28 w-full" />
            </div>
          ))
        ) : (
          <>
            <Group
              title="AI provider"
              rows={[
                ["Provider", settings.llm.provider === "ollama" ? "Ollama (local)" : "Google Gemini"],
                ["Answer model", <Code key="m">{settings.llm.model}</Code>],
                ["Question understanding", settings.llm.router_model ? <Code key="r">{settings.llm.router_model}</Code> : "Rule-based (router off)"],
                ["Longest answer", `${settings.llm.max_tokens.toLocaleString()} tokens`],
                [
                  "Status",
                  settings.llm.configured && settings.llm.ok ? <span className="text-emerald-800">Ready</span> : <span className="text-red-700">{settings.llm.configured ? "Not reachable" : "Not configured"}</span>,
                ],
                ["Fallback", settings.llm.fallback ? `${settings.llm.fallback}${settings.llm.fallback_ready ? " (ready)" : " (not ready, won't be used)"}` : "None"],
              ]}
              note="Keys stay on the server. Free Gemini keys can be limited to about 20 requests per model per day; each question uses up to two. Ollama runs models locally and has no quota, but needs a capable machine."
            />
            <Group
              title="Search"
              rows={[
                ["Embedding model", <Code key="e">{settings.retrieval.embedding_model.replace("sentence-transformers/", "")}</Code>],
                ["Index", settings.retrieval.vector_store],
                ["Passage length", `${settings.retrieval.chunk_size} characters, ${settings.retrieval.chunk_overlap} overlap`],
                ["Passages per question", settings.retrieval.top_k],
                ["Minimum match score", settings.retrieval.min_similarity.toFixed(2)],
              ]}
              note="If no passage reaches the minimum match score, the assistant says your documents don't cover the question instead of guessing. A high score means similar wording, not a correct answer."
            />
            <Group
              title="Files"
              rows={[
                ["Accepted types", "PDF, TXT, Markdown"],
                ["Largest file", `${settings.limits.max_upload_mb} MB`],
                ["Document limit", settings.limits.max_documents],
                ["Longest question", `${settings.limits.max_question_chars.toLocaleString()} characters`],
              ]}
              note="Scanned PDFs that contain only images can't be read, because this demo has no OCR."
            />
            <BuddyToggle />
            <section>
              <h2 className="font-semibold">Your data</h2>
              <div className="mt-3 space-y-3 border-y border-rule py-4 text-[15px] leading-relaxed text-graphite">
                <p>
                  Uploaded files and the search index are stored on this machine in <Code>backend/data</Code>. To erase everything, stop the backend and delete that folder.
                </p>
                <p>When you ask a question, your message, recent chat turns and the matching passages are sent to the configured AI provider (Gemini, or a local Ollama model), never whole documents.</p>
                <p>Chats are saved in this browser only (local storage). Deleting a chat in the sidebar removes it.</p>
              </div>
            </section>
          </>
        )}
      </div>

      <section className="mt-14 max-w-3xl">
        <h2 className="font-semibold">Running it yourself</h2>
        <ol className="mt-4 space-y-5">
          {[
            ["Add your key", <>Copy <Code>backend/.env.example</Code> to <Code>backend/.env</Code> and set <Code>GEMINI_API_KEY</Code>. Keys come from Google AI Studio.</>],
            ["Start the backend", <>In <Code>backend</Code>, run <Code>.venv/bin/uvicorn app.main:app --port 8000</Code>.</>],
            ["Start the interface", <>In <Code>frontend</Code>, run <Code>npm run dev</Code> and open localhost:5173.</>],
            ["Add documents and ask", <>Fictional samples are in <Code>backend/sample_docs</Code>. Open any citation number to read the passage behind it.</>],
          ].map(([title, body], i) => (
            <li key={i} className="grid grid-cols-[2rem_1fr] gap-2">
              <span className="font-serif text-xl leading-none text-graphite">{i + 1}</span>
              <div>
                <p className="font-medium">{title}</p>
                <p className="mt-1 text-[15px] leading-relaxed text-graphite">{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
