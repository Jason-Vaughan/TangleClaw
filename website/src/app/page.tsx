import Image from "next/image";

export default function Home() {
  const features = [
    { title: "Multi-Agent Dashboard", desc: "Monitor active sessions, system resources, and leased ports across all projects from a single centralized hub." },
    { title: "Master Session Coordination", desc: "A global structural session that observes and manages child sessions, orchestrating complex workflows with live wrap monitoring." },
    { title: "Project & Global Rules", desc: "Enforce precise governance with engine-specific settings, automated feature mapping, and customizable startup/wrap rules." },
    { title: "OpenClaw Integrations", desc: "Connect and manage remote AI clusters securely over Tailscale, dispatching workloads to dedicated hardware seamlessly." },
    { title: "Medusa Switchboard", desc: "Enable real-time inter-agent communication and auto-waking on inbound messages, turning isolated sessions into a cooperative swarm." },
    { title: "Eval Auditing & History", desc: "Track every agent action, grade exchange quality, and maintain a durable history of all sessions for continuous improvement." }
  ];

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center selection:bg-white selection:text-black font-sans">
      <main className="flex-1 w-full max-w-5xl px-6 py-24 md:py-32 flex flex-col items-center">
        
        {/* Hero Section */}
        <div className="flex flex-col items-center text-center space-y-8 max-w-3xl mb-32">
          {/* Logo Placeholder */}
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
          
          <h1 className="text-5xl md:text-7xl font-semibold tracking-tight leading-tight text-transparent bg-clip-text bg-gradient-to-br from-white via-gray-200 to-zinc-500 pb-2">
            TangleClaw
          </h1>
          <p className="text-xl md:text-2xl text-zinc-400 font-medium tracking-wide max-w-2xl">
            An open-source, local-first AI-native SDLC orchestration platform
          </p>
          <div className="pt-4">
            <a
              href="#features"
              className="inline-flex h-12 items-center justify-center rounded-full bg-white px-8 text-sm font-semibold text-black hover:bg-zinc-200 transition-colors"
            >
              Explore the Platform
            </a>
          </div>
        </div>

        {/* Feature Grid */}
        <div id="features" className="w-full pt-12 border-t border-white/10">
          <h2 className="text-3xl font-semibold tracking-tight mb-16 text-center">Platform Capabilities</h2>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 md:gap-8">
            {features.map((feature, i) => (
              <div 
                key={i} 
                className="group p-8 rounded-3xl bg-zinc-900/50 border border-white/5 hover:border-white/20 transition-all hover:bg-zinc-900 duration-300"
              >
                <h3 className="text-lg font-semibold text-white mb-3 tracking-tight">
                  {feature.title}
                </h3>
                <p className="text-zinc-400 text-sm leading-relaxed">
                  {feature.desc}
                </p>
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
