"use client";
export default function ErrorBoundary({ reset }: { reset: () => void }) {
  return <div className="panel"><div className="empty-state error-state" role="alert"><h2>This view could not be loaded</h2><p>Your records have not been changed. Try loading the view again.</p><button className="button secondary" onClick={() => reset()}>Try again</button></div></div>;
}
