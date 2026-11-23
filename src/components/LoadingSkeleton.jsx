export default function LoadingSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          className="animate-pulse"
        >
          <div className="aspect-[4/5] rounded-[1.5rem] bg-brand-pale-rose" />
          <div className="mt-4 h-5 w-2/3 rounded bg-brand-pale-rose" />
          <div className="mt-2 h-4 w-1/2 rounded bg-brand-pale-rose" />
        </div>
      ))}
    </div>
  )
}
