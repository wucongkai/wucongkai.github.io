import type { Metadata } from 'next';
import { repository } from '@/site.config';
import Studio from './studio';
import './studio.css';

export const metadata: Metadata = {
  title: '写作台',
  robots: { index: false, follow: false },
};
export default function StudioPage() {
  return <Studio repository={repository} />;
}
