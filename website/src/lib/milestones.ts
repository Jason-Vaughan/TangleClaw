import fs from 'fs';
import path from 'path';

export interface GithubMilestone {
  number: number;
  title: string;
  description: string | null;
  state: 'open' | 'closed';
  open_issues: number;
  closed_issues: number;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface ProcessedMilestone {
  number: number;
  title: string;
  description: string;
  html_url: string;
  state: 'open' | 'closed';
  open_issues: number;
  closed_issues: number;
  completed_date?: string; // from featured tag
}

export interface MilestoneFeedData {
  current: ProcessedMilestone | null;
  latestCompleted: ProcessedMilestone | null;
  fetchedAt: string;
}

const CURRENT_TAG_REGEX = /<!--\s*tangleclaw:website\s+current\s*-->/g;
const FEATURED_TAG_REGEX = /<!--\s*tangleclaw:website\s+featured\s+completed=([0-9]{4}-[0-9]{2}-[0-9]{2})\s*-->/g;

// Simple file-based cache to persist last-known-good state across Next.js dev reloads and serverless cold starts
const getCachePath = () => {
  const isVercel = process.env.VERCEL === '1';
  return isVercel ? '/tmp/tangleclaw_milestones_cache.json' : path.join(process.cwd(), '.next', 'tangleclaw_milestones_cache.json');
};

let memoryCache: MilestoneFeedData | null = null;

function readCache(): MilestoneFeedData | null {
  if (memoryCache) return memoryCache;
  try {
    const cachePath = getCachePath();
    if (fs.existsSync(cachePath)) {
      const data = fs.readFileSync(cachePath, 'utf8');
      return JSON.parse(data) as MilestoneFeedData;
    }
  } catch (e) {
    // Ignore cache read errors
  }
  return null;
}

function writeCache(data: MilestoneFeedData) {
  memoryCache = data;
  try {
    const cachePath = getCachePath();
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(cachePath, JSON.stringify(data), 'utf8');
  } catch (e) {
    // Ignore cache write errors
  }
}

// Simple HTML/Markdown sanitization
function sanitize(text: string): string {
  if (!text) return '';
  return text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/\bon\w+\s*=\s*(['"])[^'"]*\1/gi, '')
    .replace(/\bon\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, 'about:blank');
}

export async function fetchMilestones(): Promise<MilestoneFeedData | null> {
  const url = 'https://api.github.com/repos/Jason-Vaughan/TangleClaw/milestones?state=all&per_page=100';
  
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'TangleClaw-Website'
  };

  // Optional: Use a read-only token if available to avoid rate limits
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  let response;
  try {
    response = await fetch(url, {
      headers,
      // @ts-ignore: Next.js extends fetch RequestInit
      next: { revalidate: 60 } // Next.js fetch cache for 60 seconds
    });
  } catch (error) {
    console.error('Failed to fetch milestones (network error):', error);
    return readCache();
  }

  if (!response.ok) {
    console.error(`Failed to fetch milestones (HTTP ${response.status}):`, await response.text());
    return readCache();
  }

  let milestones: GithubMilestone[];
  try {
    milestones = await response.json();
  } catch (error) {
    console.error('Failed to parse milestones JSON:', error);
    return readCache();
  }

  return processMilestones(milestones);
}

export function processMilestones(milestones: GithubMilestone[]): MilestoneFeedData {
  let currentCandidates: ProcessedMilestone[] = [];
  let featuredCandidates: ProcessedMilestone[] = [];

  for (const m of milestones) {
    const desc = m.description || '';
    
    // Count occurrences
    const currentMatches = [...desc.matchAll(CURRENT_TAG_REGEX)];
    const featuredMatches = [...desc.matchAll(FEATURED_TAG_REGEX)];
    
    const hasCurrent = currentMatches.length > 0;
    const hasFeatured = featuredMatches.length > 0;

    // Reject malformed/duplicate/both tags
    if (currentMatches.length > 1 || featuredMatches.length > 1 || (hasCurrent && hasFeatured)) {
      continue;
    }

    if (hasCurrent) {
      if (m.state === 'closed') {
        // Current tag on closed is rejected
        continue;
      }
      
      const strippedDesc = sanitize(desc.replace(CURRENT_TAG_REGEX, '').trim());
      currentCandidates.push({
        number: m.number,
        title: m.title,
        description: strippedDesc,
        html_url: m.html_url,
        state: m.state,
        open_issues: m.open_issues,
        closed_issues: m.closed_issues
      });
    }

    if (hasFeatured) {
      if (m.state === 'open' || m.open_issues > 0) {
        // Featured tag on open milestone or milestone with open issues is rejected
        continue;
      }

      const completedDate = featuredMatches[0][1]; // Extract YYYY-MM-DD
      const strippedDesc = sanitize(desc.replace(FEATURED_TAG_REGEX, '').trim());
      
      featuredCandidates.push({
        number: m.number,
        title: m.title,
        description: strippedDesc,
        html_url: m.html_url,
        state: m.state,
        open_issues: m.open_issues,
        closed_issues: m.closed_issues,
        completed_date: completedDate
      });
    }
  }

  // Two current milestones fail closed rather than selecting one
  let current: ProcessedMilestone | null = null;
  if (currentCandidates.length === 1) {
    current = currentCandidates[0];
  }

  // Sort featured candidates by explicit completion date (desc), then tie-break by milestone number (desc)
  featuredCandidates.sort((a, b) => {
    if (a.completed_date! > b.completed_date!) return -1;
    if (a.completed_date! < b.completed_date!) return 1;
    return b.number - a.number;
  });

  const latestCompleted = featuredCandidates.length > 0 ? featuredCandidates[0] : null;

  const data: MilestoneFeedData = {
    current,
    latestCompleted,
    fetchedAt: new Date().toISOString()
  };

  writeCache(data);
  return data;
}
