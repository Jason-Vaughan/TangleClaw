"use client";

import { useEffect, useState } from "react";

export default function VersionBadge() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    async function fetchVersion() {
      try {
        const res = await fetch("https://api.github.com/repos/Jason-Vaughan/TangleClaw/releases/latest");
        if (res.ok) {
          const data = await res.json();
          setVersion(data.tag_name);
        }
      } catch (error) {
        console.error("Failed to fetch latest version", error);
      }
    }
    fetchVersion();
  }, []);

  if (!version) return null;

  return (
    <a 
      href={`https://github.com/Jason-Vaughan/TangleClaw/releases/tag/${version}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center justify-center px-3 py-1 mt-2 text-xs font-semibold text-green-400 bg-green-500/10 border border-green-500/20 rounded-full hover:bg-green-500/20 transition-colors"
    >
      {version}
    </a>
  );
}
