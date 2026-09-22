"use client";

import Image from "next/image";
import { useState } from "react";
import VersionBadge from "./components/VersionBadge";

export default function Home() {
  const [selectedImage, setSelectedImage] = useState<{src: string, alt: string} | null>(null);

  const mainFeatures = [
    {
      title: "Know what every agent is doing",
      desc: "See running, idle, disconnected, blocked and failed sessions. Inspect live terminals, launch state, history and recovery evidence from desktop or mobile."
    },
    {
      title: "Give every project a lead",
      desc: "A persistent Project Master coordinates roadmaps, agents, governance and decision flow while specialized Builders do the implementation."
    },
    {
      title: "Keep work alive",
      desc: "Tmux-backed sessions survive network interruptions. Structured checkpoints, handoffs, searchable history and memory preserve continuity between sessions and engines."
    },
    {
      title: "Coordinate across AI engines",
      desc: "Medusa connects Claude Code, Codex, Antigravity, Aider and OpenClaw. Engine profiles declare what each integration can actually do."
    },
    {
      title: "Governance that improves",
      desc: "Project and global rules guide every session. TangleClaw captures recurring lessons and proposes durable rule improvements for operator review."
    },
    {
      title: "Ship through GitHub",
      desc: "Issues, branches, pull requests, checks, reviews, changelogs and release preparation remain part of the same public, auditable workflow."
    },
    {
      title: "Local by design",
      desc: "TangleClaw runs on your hardware. Bring your existing AI accounts or local models. Built-in authentication, TLS integration, recovery controls and PortHub protect the operating environment."
    }
  ];

  const alsoIncluded = [
    "Full transcript search",
    "Session history and summaries",
    "Eval and audit metrics",
    "Engine profiles",
    "OpenClaw integration",
    "Project Rules",
    "Startup and wrap workflows",
    "Port collision prevention",
    "Secure remote and mobile access",
    "Self-update and troubleshooting tools"
  ];

  const roadmapItems = [
    { title: "Autonomous coordination", desc: "Train and release coordination across agents." },
    { title: "Specialized roles", desc: "Dedicated review and security roles." },
    { title: "Scale", desc: "Larger, portable multi-agent fleets." }
  ];

  const galleryImages = [
    { src: "/screenshots/Dashboard.png", alt: "TangleClaw Dashboard" },
    { src: "/screenshots/master session.png", alt: "Master Session Interface" },
    { src: "/screenshots/project settings 1.png", alt: "Project Settings" },
    { src: "/screenshots/open claw integration.png", alt: "OpenClaw Integrations" },
    { src: "/screenshots/session history detail.png", alt: "Session History" },
    { src: "/screenshots/global settings.png", alt: "Global Settings" },
    { src: "/screenshots/Project Rules 2.png", alt: "Project Rules" },
    { src: "/screenshots/eval audit.png", alt: "Eval Audit Metrics" },
    { src: "/screenshots/open claw list.png", alt: "OpenClaw Cluster List" },
    { src: "/screenshots/project settings 2 - startup and wrap rules.png", alt: "Startup & Wrap Rules" },
    { src: "/screenshots/session history summary list.png", alt: "Session History Summary" }
  ];

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center selection:bg-white selection:text-black font-sans">
      <main className="flex-1 w-full max-w-5xl px-6 py-24 md:py-32 flex flex-col items-center">
        
        {/* Hero Section */}
        <div className="flex flex-col items-center text-center space-y-8 mb-24 w-full">
          <div className="relative w-32 h-32 md:w-40 md:h-40 bg-zinc-900 rounded-[2rem] border border-white/10 flex items-center justify-center overflow-hidden shadow-2xl">
            <Image src="/tangleclaw-logo-real.png" alt="TangleClaw Logo" width={160} height={160} className="object-contain" priority />
          </div>

          <div className="space-y-8 max-w-4xl flex flex-col items-center mx-auto">
            <div className="flex flex-col items-center">
              <h1 className="text-5xl md:text-7xl font-semibold tracking-tight leading-tight text-transparent bg-clip-text bg-gradient-to-br from-white via-gray-200 to-zinc-500 pb-2 text-center w-full">
                Run your AI development team.
              </h1>
              <div className="mt-4"><VersionBadge /></div>
            </div>
            
            <p className="text-xl md:text-2xl text-zinc-400 font-medium tracking-wide max-w-3xl mx-auto text-center w-full leading-relaxed">
              TangleClaw turns separate AI coding terminals into a persistent, supervised software-development team — coordinated from your own machine.
            </p>

            <div className="flex flex-col sm:flex-row gap-4 pt-6">
              <a href="https://github.com/Jason-Vaughan/TangleClaw" target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center px-8 py-4 text-base font-semibold text-black bg-white rounded-full hover:bg-gray-200 transition-colors shadow-lg hover:shadow-xl hover:scale-105 duration-200">
                Install TangleClaw
              </a>
              <a href="https://github.com/Jason-Vaughan/TangleClaw" target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center px-8 py-4 text-base font-semibold text-white bg-zinc-900 border border-white/10 rounded-full hover:bg-zinc-800 transition-colors duration-200">
                View on GitHub
              </a>
            </div>

            <div className="pt-8 text-zinc-500 font-medium tracking-widest uppercase text-sm md:text-base flex flex-wrap justify-center gap-x-3 gap-y-2">
              <span>Claude Code</span>
              <span>&middot;</span>
              <span>Codex</span>
              <span>&middot;</span>
              <span>Antigravity</span>
              <span>&middot;</span>
              <span>Aider</span>
              <span>&middot;</span>
              <span>OpenClaw</span>
            </div>
          </div>
        </div>

        {/* The Story / Main Features */}
        <div id="features" className="w-full pt-16 border-t border-white/10">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-16 mb-20 max-w-4xl mx-auto">
            {mainFeatures.map((feature, i) => (
              <div key={i} className={`flex flex-col ${i === mainFeatures.length - 1 && mainFeatures.length % 2 !== 0 ? 'md:col-span-2 md:max-w-xl md:mx-auto text-center' : ''}`}>
                <h3 className="text-2xl font-semibold mb-4 text-zinc-100">{feature.title}</h3>
                <p className="text-zinc-400 text-lg leading-relaxed">{feature.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Also Included (Compact) */}
        <div id="also-included" className="w-full pt-16 pb-16 border-t border-white/10">
          <h2 className="text-2xl font-semibold tracking-tight mb-8 text-center text-zinc-300">Also Included</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4 max-w-3xl mx-auto text-zinc-400">
            {alsoIncluded.map((item, i) => (
              <div key={i} className="flex items-center">
                <span className="text-green-500 mr-3 text-lg leading-none">•</span>
                <span className="text-base">{item}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Screenshot Gallery */}
        <div id="gallery" className="w-full pt-16 border-t border-white/10">
          <h2 className="text-3xl font-semibold tracking-tight mb-12 text-center">Interface Preview</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {galleryImages.map((img, i) => (
              <div 
                key={i} 
                className="relative rounded-2xl overflow-hidden border border-white/10 bg-zinc-900/50 aspect-video group cursor-pointer"
                onClick={() => setSelectedImage(img)}
              >
                <Image src={img.src} alt={img.alt} fill className="object-contain p-4 opacity-90 group-hover:opacity-100 group-hover:scale-105 transition-all duration-300" sizes="(max-width: 768px) 100vw, 50vw" />
                <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/90 via-black/40 to-transparent pointer-events-none">
                  <p className="text-sm font-medium text-white">{img.alt}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Roadmap */}
        <div id="roadmap" className="w-full pt-20 pb-12 flex flex-col items-center">
          <h2 className="text-2xl font-semibold tracking-tight mb-8 text-center text-zinc-400">On the Roadmap</h2>
          <div className="flex flex-col sm:flex-row flex-wrap justify-center gap-6 max-w-3xl">
            {roadmapItems.map((item, i) => (
              <div key={i} className="px-6 py-4 rounded-2xl bg-zinc-950/50 border border-white/5 border-dashed flex-1 min-w-[250px]">
                <h3 className="text-base font-semibold mb-1 text-zinc-300">{item.title}</h3>
                <p className="text-zinc-500 text-sm">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>

      </main>

      <footer className="w-full py-10 border-t border-white/10 text-center flex flex-col items-center space-y-4">
        <p className="text-sm text-zinc-500">
          &copy; {new Date().getFullYear()} TangleClaw.
        </p>
        <a href="https://github.com/Jason-Vaughan/TangleClaw/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" className="text-sm text-zinc-500 hover:text-white transition-colors underline decoration-white/20 underline-offset-4">
          View License on GitHub
        </a>
      </footer>

      {/* Lightbox Modal */}
      {selectedImage && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 p-4 md:p-12 cursor-zoom-out backdrop-blur-sm"
          onClick={() => setSelectedImage(null)}
        >
          <div className="relative w-full h-full max-w-7xl flex flex-col">
            <div className="flex-1 relative">
              <Image src={selectedImage.src} alt={selectedImage.alt} fill className="object-contain" sizes="100vw" priority />
            </div>
            <div className="absolute bottom-4 left-0 right-0 text-center">
              <span className="bg-black/60 text-white px-4 py-2 rounded-full text-sm backdrop-blur-md border border-white/10">
                {selectedImage.alt}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
