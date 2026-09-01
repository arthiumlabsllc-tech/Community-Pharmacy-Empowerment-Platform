'use client';

export default function OfflinePage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="text-center max-w-md">
        <div className="text-6xl mb-6">📡</div>
        <h1 className="text-2xl font-bold text-gray-900 mb-3">You&apos;re Offline</h1>
        <p className="text-gray-500 mb-6">
          Don&apos;t worry — your data is saved locally. When your internet connection is restored,
          all your changes will sync automatically.
        </p>
        <div className="space-y-4">
          <button
            onClick={() => window.location.reload()}
            className="btn-primary btn-lg w-full"
          >
            Try Again
          </button>
          <p className="text-xs text-gray-400">
            You can still view previously loaded pages and make changes.
            Changes will be synced when you&apos;re back online.
          </p>
        </div>
      </div>
    </div>
  );
}
