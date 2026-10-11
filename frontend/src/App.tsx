import { useEffect, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { Menu } from "lucide-react";
import { accessKey, api, type AppSettings } from "./services/api";
import { useDocuments } from "./hooks/useDocuments";
import { Sidebar, Wordmark, type Page } from "./components/Sidebar";
import { Button, ToastProvider, spring } from "./components/ui";
import { ChatView } from "./features/chat/ChatView";
import { useConversations } from "./features/chat/useConversations";
import { DocumentsPage } from "./features/documents/DocumentsPage";
import { useUploads } from "./features/documents/useUploads";
import { SettingsPage } from "./features/settings/SettingsPage";
import { HomePage } from "./features/home/HomePage";
import { CursorBuddy } from "./components/CursorBuddy";

const PAGES: Page[] = ["home", "chat", "documents", "settings"];
const pageFromHash = (): Page => {
  const h = window.location.hash.replace("#/", "") as Page;
  return PAGES.includes(h) ? h : "home";
};

/** Shown when the backend requires API_ACCESS_KEY and we don't have a valid one. */
function AccessGate({ onSaved }: { onSaved: () => void }) {
  const [key, setKey] = useState("");
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/20 p-4 backdrop-blur-[2px]">
      <motion.form
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={spring}
        onSubmit={(e) => {
          e.preventDefault();
          accessKey.set(key.trim());
          onSaved();
        }}
        className="w-[min(92vw,400px)] rounded-xl bg-white p-6 shadow-xl ring-1 ring-rule"
      >
        <h2 className="text-lg font-semibold">Enter the access key</h2>
        <p className="mt-2 text-[15px] text-graphite">This KnowledgeBridge deployment is private. Ask the person who shared it for the access key.</p>
        <label htmlFor="access-key" className="sr-only">
          Access key
        </label>
        <input id="access-key" type="password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} className="mt-4 h-10 w-full rounded-lg px-3 ring-1 ring-rule outline-none focus:ring-2 focus:ring-bridge" />
        <Button type="submit" variant="primary" className="mt-4 w-full" disabled={!key.trim()}>
          Continue
        </Button>
      </motion.form>
    </div>
  );
}

function Shell() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [menuOpen, setMenuOpen] = useState(false);
  const [needKey, setNeedKey] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const documents = useDocuments();
  const uploads = useUploads(documents, settings);
  const chats = useConversations();

  const loadSettings = () => api.settings().then(setSettings, (e: Error) => setSettingsError(e.message));
  useEffect(() => {
    loadSettings();
    const onHash = () => setPage(pageFromHash());
    const onAccess = () => setNeedKey(true);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("kb:access-required", onAccess);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("kb:access-required", onAccess);
    };
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const navigate = (p: Page) => {
    window.location.hash = `/${p}`;
    setPage(p);
    window.scrollTo(0, 0);
  };
  const sidebar = (onClose?: () => void) => <Sidebar page={page} navigate={navigate} docs={documents.docs} chats={chats} uploads={uploads} settings={settings} onClose={onClose} />;

  const gate = needKey && (
    <AccessGate
      onSaved={() => {
        setNeedKey(false);
        setSettingsError(null);
        loadSettings();
        documents.refresh();
      }}
    />
  );

  if (page === "home")
    return (
      <motion.div key="home" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
        <HomePage navigate={navigate} docs={documents.docs} settings={settings} />
        {gate}
      </motion.div>
    );

  return (
    <motion.div className="flex min-h-dvh" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
      <aside className="sticky top-0 hidden h-dvh w-72 shrink-0 border-r border-rule/80 bg-paper md:block">{sidebar()}</aside>

      <div className="flex min-w-0 flex-1 flex-col bg-ivory">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-rule/80 bg-ivory/90 px-4 backdrop-blur md:hidden">
          <button onClick={() => navigate("home")} aria-label="KnowledgeBridge home">
            <Wordmark />
          </button>
          <button onClick={() => setMenuOpen(true)} className="rounded-lg p-2 text-graphite hover:text-ink" aria-label="Open menu">
            <Menu className="size-5" />
          </button>
        </header>

        <AnimatePresence>
          {menuOpen && (
            <motion.div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Menu" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="absolute inset-0 bg-ink/20" onClick={() => setMenuOpen(false)} />
              <motion.div
                className="absolute inset-y-0 left-0 w-[min(85vw,320px)] bg-paper shadow-xl"
                initial={{ x: -320 }}
                animate={{ x: 0 }}
                exit={{ x: -320 }}
                transition={spring}
                drag="x"
                dragConstraints={{ left: -320, right: 0 }}
                dragElastic={0.05}
                onDragEnd={(_, info) => info.offset.x < -80 && setMenuOpen(false)}
              >
                {sidebar(() => setMenuOpen(false))}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Enter-only fade: nothing waits on an exit animation, so a page can never get stuck blank. */}
        <motion.main key={page} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }} className="w-full flex-1">
          {page === "chat" && <ChatView chats={chats} documents={documents} uploads={uploads} settings={settings} navigate={navigate} />}
          {page === "documents" && (
            <div className="mx-auto max-w-4xl px-5 py-8 sm:px-8 lg:py-12">
              <DocumentsPage
                documents={documents}
                uploads={uploads}
                onDeleted={chats.forgetDocument}
                onChat={(id) => {
                  chats.newChat([id]);
                  navigate("chat");
                }}
              />
            </div>
          )}
          {page === "settings" && (
            <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8 lg:py-12">
              <SettingsPage settings={settings} error={settingsError} />
            </div>
          )}
        </motion.main>
      </div>

      {gate}
    </motion.div>
  );
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <Shell />
        <CursorBuddy />
      </ToastProvider>
    </MotionConfig>
  );
}
