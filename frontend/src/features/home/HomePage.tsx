import { motion, type Variants } from "motion/react";
import { ArrowRight, BookOpenCheck, Languages, MessageSquareText, ShieldCheck, Upload } from "lucide-react";
import type { AppSettings, DocumentRecord } from "../../services/api";
import { LiquidMark } from "../../components/brand/Mark";
import { Wordmark, type Page } from "../../components/Sidebar";
import { cx } from "../../components/ui";
import { HeroBackdrop } from "../chat/HeroBackdrop";

const ease = [0.22, 1, 0.36, 1] as const;
const stagger: Variants = { show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } } };
const rise: Variants = { hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0, transition: { duration: 0.6, ease } } };

const STEPS = [
  { icon: Upload, title: "Add your documents", body: "PDF, TXT or Markdown. Each file is split into passages and indexed on your server." },
  { icon: MessageSquareText, title: "Ask in your own words", body: "English, Telugu or a mix of both. Typos and casual phrasing are fine." },
  { icon: BookOpenCheck, title: "Check the source", body: "Every answer cites the passage and page it came from, one click away." },
];

const PROMISES = [
  { icon: ShieldCheck, title: "No guessing", body: "If your files don't say it, KnowledgeBridge tells you so." },
  { icon: Languages, title: "Bilingual", body: "Replies in the language you asked in." },
  { icon: BookOpenCheck, title: "Scoped search", body: "Pick one document or search them all." },
];

/** Starting page. Full-screen, no sidebar; everything here leads into the workspace. */
export function HomePage({ navigate, docs, settings }: { navigate: (p: Page) => void; docs: DocumentRecord[] | null; settings: AppSettings | null }) {
  const ready = docs?.filter((d) => d.status === "indexed").length ?? 0;
  const llmOk = !!settings?.llm.configured && settings.llm.ok;

  return (
    <div className="relative min-h-dvh overflow-x-hidden">
      <div className="absolute inset-x-0 top-0 h-[min(92dvh,760px)]">
        <HeroBackdrop />
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-ivory" />
      </div>

      <div className="relative mx-auto flex max-w-6xl flex-col px-5 sm:px-8">
        <motion.nav initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease }} className="flex h-20 items-center justify-between">
          <Wordmark />
          <button onClick={() => navigate("chat")} className="rounded-full px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-white/70">
            Open workspace
          </button>
        </motion.nav>

        <motion.section variants={stagger} initial="hidden" animate="show" className="max-w-2xl pt-12 pb-20 sm:pt-20 sm:pb-28">
          <motion.div variants={rise}>
            <LiquidMark size={72} />
          </motion.div>
          <motion.h1 variants={rise} className="mt-8 text-[clamp(2.2rem,5.4vw,3.9rem)] leading-[1.04] font-medium tracking-[-0.03em]">
            Your documents,
            <br />
            <span className="font-serif font-normal text-indigo italic">answering back.</span>
          </motion.h1>
          <motion.p variants={rise} className="mt-6 max-w-lg text-[17px] leading-relaxed text-graphite">
            Upload policies, manuals or notes and ask questions in plain language. KnowledgeBridge answers only from what you gave it, and shows you exactly where.
          </motion.p>
          <motion.div variants={rise} className="mt-9 flex flex-wrap items-center gap-3">
            <motion.button
              onClick={() => navigate("chat")}
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.96 }}
              className="group inline-flex h-12 items-center gap-2 rounded-full bg-gradient-to-b from-bridge to-indigo pr-5 pl-6 text-[15px] font-medium text-white shadow-[0_10px_28px_-10px_rgb(81_70_201/0.75)] transition-shadow hover:shadow-[0_14px_34px_-10px_rgb(81_70_201/0.85)]"
            >
              Start asking
              <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" strokeWidth={2.2} />
            </motion.button>
            <motion.button
              onClick={() => navigate("documents")}
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.96 }}
              className="glass inline-flex h-12 items-center gap-2 rounded-full px-5 text-[15px] font-medium text-ink"
            >
              <Upload className="size-4" strokeWidth={1.9} /> Add documents
            </motion.button>
          </motion.div>
          <motion.p variants={rise} className="mt-6 flex items-center gap-2 text-sm text-graphite">
            <span className={cx("size-2 rounded-full", docs === null ? "bg-graphite/40" : llmOk ? "bg-emerald-500" : "bg-amber-500")} />
            {docs === null
              ? "Connecting to your knowledge base…"
              : `${ready ? `${ready} document${ready === 1 ? "" : "s"} ready` : "No documents yet"}${settings ? (llmOk ? " · AI connected" : " · AI provider not ready") : ""}`}
          </motion.p>
        </motion.section>

        <section aria-labelledby="how" className="pb-16">
          <h2 id="how" className="text-sm font-medium tracking-wide text-graphite uppercase">
            How it works
          </h2>
          <motion.ol variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-60px" }} className="mt-5 grid gap-4 md:grid-cols-3">
            {STEPS.map(({ icon: Icon, title, body }, i) => (
              <motion.li key={title} variants={rise} whileHover={{ y: -4 }} className="card relative p-6 transition-shadow hover:shadow-[0_0_0_1px_rgb(58_86_212/0.25),var(--shadow-float)]">
                <span className="absolute top-5 right-6 font-serif text-3xl text-rule">{i + 1}</span>
                <span className="grid size-10 place-items-center rounded-xl bg-wash text-indigo">
                  <Icon className="size-5" strokeWidth={1.8} />
                </span>
                <p className="mt-5 font-medium">{title}</p>
                <p className="mt-1.5 text-[15px] leading-relaxed text-graphite">{body}</p>
              </motion.li>
            ))}
          </motion.ol>
        </section>

        <motion.section
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.6, ease }}
          className="mb-16 grid gap-8 rounded-[28px] bg-paper px-6 py-10 sm:px-10 md:grid-cols-[1.1fr_2fr] md:items-center"
        >
          <div>
            <p className="font-serif text-2xl leading-snug">Built to be trusted, not just to sound right.</p>
            <button onClick={() => navigate("chat")} className="mt-5 inline-flex items-center gap-1.5 text-[15px] font-medium text-bridge hover:text-bridge-deep">
              Try it now <ArrowRight className="size-4" />
            </button>
          </div>
          <ul className="grid gap-5 sm:grid-cols-3">
            {PROMISES.map(({ icon: Icon, title, body }) => (
              <li key={title}>
                <Icon className="size-5 text-indigo" strokeWidth={1.8} />
                <p className="mt-2.5 text-[15px] font-medium">{title}</p>
                <p className="mt-1 text-sm leading-relaxed text-graphite">{body}</p>
              </li>
            ))}
          </ul>
        </motion.section>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-rule py-6 text-sm text-graphite">
          <span>KnowledgeBridge AI</span>
          <span>Chats stay in this browser. Documents stay on your server.</span>
        </footer>
      </div>
    </div>
  );
}
