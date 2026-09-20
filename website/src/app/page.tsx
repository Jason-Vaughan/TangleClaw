"use client";

import Image from "next/image";
import { useState } from "react";
import VersionBadge from "./components/VersionBadge";

export default function Home() {
  const [selectedImage, setSelectedImage] = useState<{src: string, alt: string} | null>(null);

  const detailedCards = [
    { title: "Management & Governance", desc: "Project Master orchestration, roadmap planning, an automated self-learning loop, Feature Index tracking, and comprehensive settings for fine-grained AI access governance." },
    { title: "Specialized Agent Roles", desc: "Deploy a complete virtual team with distinct roles—from Architects and Project Managers to parallel Builders, plus built-in templates to create your own." },
    { title: "LLM-Agnostic Communication", desc: "Real-time cross-talk across frontier, open-source, local, or API/OAuth models. The system auto-detects and coordinates any CLI-based or Aider-compatible LLM." },
    { title: "Quality & Auditing", desc: "Critic methodology, Eval Audit Mode, and strict protocols enforcing unit and regression testing (including Vite). Fully integrated with GitHub for robust triage, PRs, and CI." },
    { title: "Operations & Supervision", desc: "Fleet health monitoring, automatic DHCP-like port lease management to prevent port collisions, and built-in troubleshooting utilities to quickly clear and fix errors." },
    { title: "Security Integration", desc: "Caddy-supported username and password authentication today, with TangleScan and SecurityClaw architecture on the roadmap." }
  ];

  const highLevelBullets = [
    "Tangle Code Review for automated PR evaluation",
    "Managed-project release automation and semantic versioning",
    "Cross-project dependency registry mapping",
    "Specialized Higher-Reasoning Architecture Agents"
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

          <div className="space-y-6 max-w-3xl flex flex-col items-center mx-auto">
            <div className="flex flex-col items-center">
              <h1 className="text-5xl md:text-7xl font-semibold tracking-tight leading-tight text-transparent bg-clip-text bg-gradient-to-br from-white via-gray-200 to-zinc-500 pb-2 text-center w-full">
                TangleClaw
              </h1>
              <VersionBadge />
            </div>
            <p className="text-xl md:text-2xl text-zinc-400 font-medium tracking-wide max-w-2xl mx-auto text-center w-full">
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

        {/* Screenshot Gallery */}
        <div id="gallery" className="w-full pt-16 mt-8 border-t border-white/10">
          <h2 className="text-3xl font-semibold tracking-tight mb-12 text-center">Interface Preview</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {galleryImages.map((img, i) => (
              <div 
                key={i} 
                className="relative rounded-2xl overflow-hidden border border-white/10 bg-zinc-900/50 aspect-video group cursor-pointer"
                onClick={() => setSelectedImage(img)}
              >
                <Image
                  src={img.src}
                  alt={img.alt}
                  fill
                  className="object-contain p-4 opacity-90 group-hover:opacity-100 group-hover:scale-105 transition-all duration-300"
                  sizes="(max-width: 768px) 100vw, 50vw"
                />
                <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/90 via-black/40 to-transparent pointer-events-none">
                  <p className="text-sm font-medium text-white">{img.alt}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Call to Action */}
        <div className="w-full pt-24 pb-12 flex flex-col items-center text-center">
          <h2 className="text-3xl md:text-4xl font-semibold tracking-tight mb-6">Ready to take control of your SDLC?</h2>
          <p className="text-zinc-400 text-lg mb-8 max-w-xl">
            TangleClaw is open-source and runs entirely on your local machine. No cloud subscriptions, no vendor lock-in.
          </p>
          <a 
            href="https://github.com/Jason-Vaughan/TangleClaw" 
            target="_blank" 
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center px-8 py-4 text-base font-semibold text-black bg-white rounded-full hover:bg-gray-200 transition-colors shadow-lg hover:shadow-xl hover:scale-105 duration-200"
          >
            Install Now in Minutes
            <svg className="w-5 h-5 ml-2 -mr-1" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </a>
        </div>
      </main>

      <footer className="w-full py-10 border-t border-white/10 text-center">
        <p className="text-sm text-zinc-500">
          &copy; {new Date().getFullYear()} TangleClaw. All rights reserved.
        </p>
      </footer>

      {/* Lightbox Modal */}
      {selectedImage && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 p-4 md:p-12 cursor-zoom-out backdrop-blur-sm"
          onClick={() => setSelectedImage(null)}
        >
          <div className="relative w-full h-full max-w-7xl flex flex-col">
            <div className="flex-1 relative">
              <Image
                src={selectedImage.src}
                alt={selectedImage.alt}
                fill
                className="object-contain"
                sizes="100vw"
                priority
              />
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
