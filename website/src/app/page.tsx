import Image from "next/image";

export default function Home() {
  const detailedCards = [
    { title: "Management & Governance", desc: "Project Master orchestration, roadmap planning, and strict rule enforcement." },
    { title: "Specialized Agent Roles", desc: "Deploy a complete virtual team with distinct roles—from Architects and Project Managers to parallel Builders." },
    { title: "LLM-Agnostic Communication", desc: "The Medusa Switchboard enables real-time cross-talk, allowing team agents running on completely different LLMs to seamlessly coordinate." },
    { title: "Quality & Auditing", desc: "Critic methodology, Eval Audit Mode, and adversarial-agent primitives." },
    { title: "Operations & Supervision", desc: "Fleet health monitoring, idle/wedged detection, and PortHub service supervision." },
    { title: "Security Integration", desc: "Robust authentication and governance today, with TangleScan and SecurityClaw architecture on the roadmap." }
  ];

  const highLevelBullets = [
    "Tangle Code Review for automated PR evaluation",
    "Managed-project release automation and semantic versioning",
    "Cross-project dependency registry mapping",
    "Specialized Higher-Reasoning Architecture Agents"
  ];

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center selection:bg-white selection:text-black font-sans">
      <main className="flex-1 w-full max-w-5xl px-6 py-24 md:py-32 flex flex-col items-center">
        
        {/* Hero Section */}
        <div className="flex flex-col items-center text-center space-y-8 mb-24">
          
          {/* Logo */}
          <div className="relative w-32 h-32 md:w-40 md:h-40 bg-zinc-900 rounded-[2rem] border border-white/10 flex items-center justify-center overflow-hidden shadow-2xl">
            <Image
              src="/tangleclaw-logo-real.png"
              alt="TangleClaw Logo"
              width={160}
              height={160}
              className="object-contain"
              priority
            />
          </div>

          <div className="space-y-6 max-w-3xl">
            <h1 className="text-5xl md:text-7xl font-semibold tracking-tight leading-tight text-transparent bg-clip-text bg-gradient-to-br from-white via-gray-200 to-zinc-500 pb-2">
              TangleClaw
            </h1>
            <p className="text-xl md:text-2xl text-zinc-400 font-medium tracking-wide max-w-2xl">
              An open-source, local-first AI-native SDLC orchestration platform.
            </p>
            
            <ul className="flex flex-col md:flex-row flex-wrap justify-center items-center gap-x-8 gap-y-3 pt-6 text-zinc-300 text-sm md:text-base font-medium">
              {highLevelBullets.map((bullet, i) => (
                <li key={i} className="flex items-center">
                  <span className="text-green-500 mr-2 text-xl leading-none">•</span>
                  <span>{bullet}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Platform Capabilities */}
        <div id="features" className="w-full pt-16 border-t border-white/10">
          <h2 className="text-3xl font-semibold tracking-tight mb-16 text-center">Platform Capabilities</h2>
          
          {/* Detailed Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 md:gap-8 mb-16">
            {detailedCards.map((card, i) => (
              <div key={i} className="p-6 md:p-8 rounded-3xl bg-zinc-950 border border-white/5 hover:bg-zinc-900/50 hover:border-white/10 transition-colors group">
                <h3 className="text-lg font-semibold mb-3 text-zinc-100 group-hover:text-white transition-colors">{card.title}</h3>
                <p className="text-zinc-400 text-sm leading-relaxed">{card.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </main>

      <footer className="w-full py-10 border-t border-white/10 text-center">
        <p className="text-sm text-zinc-500">
          &copy; {new Date().getFullYear()} TangleClaw. All rights reserved.
        </p>
      </footer>
    </div>
  );
}
