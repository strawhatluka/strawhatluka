import { Octokit } from '@octokit/rest';
import { readFileSync, writeFileSync } from 'node:fs';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const USERNAME = 'strawhatluka';

function replaceSection(content, marker, newContent) {
  const regex = new RegExp(
    `(<!-- ${marker}:START -->)[\\s\\S]*?(<!-- ${marker}:END -->)`,
    'g'
  );
  return content.replace(regex, `$1\n${newContent}\n$2`);
}

async function buildCurrentlyBuilding() {
  const { data: repos } = await octokit.rest.repos.listForUser({
    username: USERNAME,
    sort: 'pushed',
    direction: 'desc',
    per_page: 100,
    type: 'owner'
  });

  const repo = repos.filter(r => r.name !== USERNAME)[0];

  if (!repo) return 'No recent activity';

  const date = new Date(repo.pushed_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const description = repo.description || 'No description';
  return `Currently building: [${repo.name}](${repo.html_url}) — ${description} (last pushed: ${date})`;
}


async function buildOSSContributions() {
  let items;
  try {
    const { data } = await octokit.rest.search.issuesAndPullRequests({
      q: `author:${USERNAME} type:pr is:merged -user:${USERNAME}`,
      sort: 'created',
      order: 'desc',
      per_page: 20
    });
    items = data.items;
  } catch (err) {
    console.error('OSS search failed:', err.message);
    return '*Unable to fetch contributions — API error.*';
  }

  const qualified = [];

  for (const item of items) {
    try {
      // Parse owner/repo from repository_url
      const parts = item.repository_url.split('/');
      const repo = parts[parts.length - 1];
      const owner = parts[parts.length - 2];

      // Fetch full PR details for additions/deletions and labels
      const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: item.number
      });

      // Quality filter: feature/enhancement labels pass regardless of size
      const labels = pr.labels.map(l => l.name.toLowerCase());
      const hasFeatureLabel = labels.includes('feature') || labels.includes('enhancement');
      const linesChanged = (pr.additions || 0) + (pr.deletions || 0);

      if (!hasFeatureLabel && linesChanged < 50) continue;

      // Fetch repo languages for tech line
      let techLine = 'Tech: (no language data)';
      try {
        const { data: languages } = await octokit.rest.repos.listLanguages({ owner, repo });
        const topLangs = Object.entries(languages)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([lang]) => lang);
        if (topLangs.length > 0) {
          techLine = `Tech: ${topLangs.join(' \u00b7 ')}`;
        }
      } catch {
        // Use fallback tech line
      }

      // Clean PR title: trim whitespace, strip conventional commit prefix, capitalize first letter
      let cleaned = item.title.trim().replace(/^[a-z]+(\([^)]*\))?[:\!]\s*/i, '');
      cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);

      // Format repo name: split on hyphens, capitalize each word
      const displayName = repo.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

      qualified.push({
        merged_at: pr.merged_at,
        block: `### ${displayName}\n\n${cleaned}\n\n\u2192 [Merged PR #${item.number}](${item.html_url})\n\n${techLine}`
      });
    } catch {
      // Skip PR if detail fetch fails
      continue;
    }
  }

  if (qualified.length === 0) {
    return '*No qualifying open source contributions found.*';
  }

  // Sort by merged_at descending, cap at 5
  qualified.sort((a, b) => new Date(b.merged_at) - new Date(a.merged_at));
  return qualified.slice(0, 5).map(q => q.block).join('\n\n');
}

async function main() {
  let content = readFileSync('README.md', 'utf8');
  content = replaceSection(content, 'OSS_CONTRIBUTIONS', await buildOSSContributions());
  content = replaceSection(content, 'CURRENTLY_BUILDING', await buildCurrentlyBuilding());
  writeFileSync('README.md', content, 'utf8');
  console.log('README.md updated successfully.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
