import Link from 'next/link'

export default function Home() {
  return (
    <div className="font-sans flex flex-col gap-12 items-center justify-center min-h-screen p-8 pb-20 sm:p-20">
      <Link href="/stream" className="border bg-blue-50 text-blue-400 rounded-sm w-40 p-4 hover:bg-blue-100">Stream</Link>
      <Link href="/watch" className="border bg-blue-50 text-blue-400 rounded-sm w-40 p-4 hover:bg-blue-100">Watch</Link>
    </div>
  );
}
