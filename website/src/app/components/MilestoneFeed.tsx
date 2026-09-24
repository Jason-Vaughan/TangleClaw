import { fetchMilestones } from '@/lib/milestones';
import ReactMarkdown from 'react-markdown';

export default async function MilestoneFeed() {
  const data = await fetchMilestones();

  if (!data) {
    return null; // Don't render if we have no data and no cache
  }

  const { current, latestCompleted } = data;

  if (!current && !latestCompleted) {
    return null;
  }

  return (
    <div className="w-full flex flex-col items-center mt-6 space-y-6">
      <h2 className="text-xl font-semibold text-zinc-300">Project Milestones</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-4xl">
        {/* Current Milestone */}
        {current && (
          <div className="flex flex-col bg-zinc-900/40 border border-zinc-800 rounded-xl p-6 relative overflow-hidden group">
            <div className="absolute top-0 left-0 w-full h-1 bg-green-500/80"></div>
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs font-bold uppercase tracking-wider text-green-400 bg-green-500/10 px-2 py-1 rounded-md">
                Current Focus
              </span>
              <a 
                href={current.html_url} 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-sm text-zinc-400 hover:text-white transition-colors"
              >
                GitHub ↗
              </a>
            </div>
            <h3 className="text-xl font-semibold text-zinc-100 mb-2">{current.title}</h3>
            
            <div className="flex-1 text-sm text-zinc-400 mb-6 line-clamp-3">
              <ReactMarkdown className="[&>p]:mb-2 [&>a]:text-green-400 [&>a]:underline">{current.description || ''}</ReactMarkdown>
            </div>
            
            <div className="mt-auto">
              <div className="flex items-center justify-between text-xs text-zinc-500 mb-2">
                <span>Progress</span>
                <span>{current.closed_issues} / {current.open_issues + current.closed_issues} issues</span>
              </div>
              <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-green-500" 
                  style={{ width: `${(current.closed_issues / Math.max(1, current.open_issues + current.closed_issues)) * 100}%` }}
                ></div>
              </div>
            </div>
          </div>
        )}

        {/* Latest Completed Milestone */}
        {latestCompleted && (
          <div className="flex flex-col bg-zinc-900/40 border border-zinc-800 rounded-xl p-6 relative overflow-hidden group">
            <div className="absolute top-0 left-0 w-full h-1 bg-purple-500/80"></div>
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs font-bold uppercase tracking-wider text-purple-400 bg-purple-500/10 px-2 py-1 rounded-md">
                Latest Release
              </span>
              <a 
                href={latestCompleted.html_url} 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-sm text-zinc-400 hover:text-white transition-colors"
              >
                GitHub ↗
              </a>
            </div>
            <h3 className="text-xl font-semibold text-zinc-100 mb-1">{latestCompleted.title}</h3>
            {latestCompleted.completed_date && (
              <p className="text-xs text-zinc-500 mb-4">
                Completed on {new Date(latestCompleted.completed_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
              </p>
            )}
            
            <div className="flex-1 text-sm text-zinc-400 line-clamp-3">
              <ReactMarkdown className="[&>p]:mb-2 [&>a]:text-purple-400 [&>a]:underline">{latestCompleted.description || ''}</ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
