import about from './content/site/about.json';
import projects from './content/site/projects.json';
import publications from './content/site/publications.json';

// Deployment settings stay in code; editable content lives in content/site/.
export const repository = {
  owner: 'wucongkai',
  name: 'wucongkai.github.io',
  branch: 'main',
};
export const site = {
  ...about,
  url: 'https://wucongkai.github.io',
  projects: projects as {
    name: string;
    description: string;
    href: string;
    label: string;
  }[],
  publications,
};
