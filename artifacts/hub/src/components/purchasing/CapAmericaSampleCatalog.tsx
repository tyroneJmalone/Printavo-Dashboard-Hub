import { useState, useMemo } from "react";
import { Search, ExternalLink, AlertTriangle, Image as ImageIcon, CheckCircle, Info } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { capAmericaSamples, type CapAmericaSample } from "@/data/capAmericaSamples";

export function CapAmericaSampleCatalog() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedStyle, setSelectedStyle] = useState<CapAmericaSample | null>(capAmericaSamples[0] ?? null);
  const [selectedColor, setSelectedColor] = useState<string | null>(null);
  const [showCatalogPage, setShowCatalogPage] = useState(false);
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());

  const handleImageError = (url: string) => {
    setFailedImages(prev => {
      const next = new Set(prev);
      next.add(url);
      return next;
    });
  };

  const filteredSamples = useMemo(() => {
    if (!searchQuery.trim()) return capAmericaSamples;
    const lowerQ = searchQuery.trim().toLowerCase();
    return capAmericaSamples.filter((sample) => {
      if (sample.style.toLowerCase().includes(lowerQ)) return true;
      if (sample.title.toLowerCase().includes(lowerQ)) return true;
      if (sample.description.toLowerCase().includes(lowerQ)) return true;
      if (sample.colors.some((c) => c.name.toLowerCase().includes(lowerQ))) return true;
      return false;
    });
  }, [searchQuery]);

  const handleSelectStyle = (sample: CapAmericaSample) => {
    setSelectedStyle(sample);
    setSelectedColor(null);
    setShowCatalogPage(false);
  };

  return (
    <div className="flex flex-col lg:flex-row gap-6 h-full pb-6">
      {/* Left Column: Search & List */}
      <div className="w-full lg:w-[400px] flex flex-col gap-5 lg:border-r border-slate-800 lg:pr-6 flex-shrink-0">
        <div className="space-y-4">
          <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-xl">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-2">
              <Info className="w-4 h-4 text-blue-400" />
              Static Sample Catalog
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed mb-3">
              This is a read-only curated sample of Cap America styles. 
              Price and stock are explicitly unavailable. Sizes and colors represent catalog listings, not guaranteed purchasable combinations.
            </p>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 w-4 h-4" />
            <Input
              aria-label="Search Cap America sample styles"
              placeholder="Search by style, name, description, or color..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-slate-900 border-slate-700 h-10 text-sm shadow-inner"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 lg:pr-2">
          {filteredSamples.length === 0 ? (
            <div className="py-12 flex flex-col items-center justify-center text-slate-600 text-center px-4">
              <Search className="w-10 h-10 mb-3 opacity-20" />
              <p className="text-sm font-medium text-slate-400">No samples found</p>
            </div>
          ) : (
            filteredSamples.map((sample) => (
              <button
                type="button"
                key={sample.style}
                aria-pressed={selectedStyle?.style === sample.style}
                onClick={() => handleSelectStyle(sample)}
                className={`w-full text-left cursor-pointer rounded-xl border p-4 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
                  selectedStyle?.style === sample.style
                    ? "bg-slate-800 border-blue-500/50 shadow-md"
                    : "bg-slate-900/40 border-slate-800 hover:border-slate-600 hover:bg-slate-800/40"
                }`}
              >
                <div className="flex items-start gap-4">
                  <div className="w-16 h-16 rounded-md bg-slate-800/50 border border-white/10 flex-shrink-0 flex items-center justify-center overflow-hidden relative">
                    {sample.heroImageUrl && !failedImages.has(sample.heroImageUrl) ? (
                      <img
                        src={sample.heroImageUrl}
                        alt={sample.style}
                        className="w-full h-full object-cover relative z-10"
                        onError={() => handleImageError(sample.heroImageUrl)}
                      />
                    ) : (
                      <ImageIcon className="w-6 h-6 text-slate-600 absolute z-0" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-mono font-bold text-blue-400">{sample.style}</span>
                      <Badge variant="secondary" className="text-[10px] bg-slate-800 text-slate-400 border-0 h-5 px-1.5">
                        {sample.sourceYear}
                      </Badge>
                    </div>
                    <div className="text-sm font-semibold text-slate-200 truncate">{sample.title}</div>
                    <div className="text-xs text-slate-500 mt-1 line-clamp-2">{sample.description}</div>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right Column: Detail View */}
      <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col">
        {!selectedStyle ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-600 space-y-3 mt-20">
            <div className="w-16 h-16 rounded-2xl bg-slate-800/50 border border-slate-700 flex items-center justify-center">
              <ImageIcon className="w-8 h-8 text-slate-700" />
            </div>
            <p className="text-sm font-medium text-slate-400">Select a sample</p>
            <p className="text-xs">Choose a style from the list to view its catalog details.</p>
          </div>
        ) : (
          <div className="space-y-6 max-w-4xl">
            {/* Header */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
              <div className="p-6">
                <div className="flex flex-wrap gap-3 justify-between items-start mb-4">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xl font-bold font-mono text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20">
                        {selectedStyle.style}
                      </span>
                      <Badge variant="outline" className="text-xs border-slate-700 text-slate-300">
                        {selectedStyle.brand}
                      </Badge>
                    </div>
                    <h2 className="text-2xl font-bold text-white tracking-tight">{selectedStyle.title}</h2>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="bg-slate-800 border-slate-700 hover:bg-slate-700 text-slate-300 gap-2 h-8"
                    onClick={() => window.open(selectedStyle.sourceUrl, '_blank', 'noopener,noreferrer')}
                  >
                    Source <ExternalLink className="w-3 h-3" />
                  </Button>
                </div>
                <p className="text-sm text-slate-400 leading-relaxed mb-6">{selectedStyle.description}</p>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Features */}
                  <div>
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Features</h4>
                    <ul className="space-y-2">
                      {selectedStyle.features.map((feature, idx) => (
                        <li key={idx} className="text-sm text-slate-300 flex items-start gap-2">
                          <CheckCircle className="w-4 h-4 text-slate-600 mt-0.5 flex-shrink-0" />
                          <span className="leading-snug">{feature}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Sizes */}
                  <div>
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Listed Sizes</h4>
                    <div className="space-y-3">
                      {selectedStyle.sizes.map((sizeGroup, idx) => (
                        <div key={idx} className="bg-slate-800/50 rounded-lg p-3 border border-slate-800">
                          <div className="text-xs font-semibold text-slate-300 mb-1">{sizeGroup.label}</div>
                          <div className="text-sm font-mono text-slate-400">{sizeGroup.range}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Status Warning */}
              <div className="bg-amber-950/20 border-t border-amber-900/50 p-4 flex gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0" />
                <div className="text-sm text-amber-400">
                  <span className="font-bold">Pricing and stock unavailable.</span> Colors and sizes are listed in the source catalog, not verified as available combinations. This sample cannot be ordered through the Hub.
                </div>
              </div>
            </div>

            {/* Colors and Visualization */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm p-6">
              <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4">Listed Colors ({selectedStyle.colors.length})</h4>
              
              <div className="flex flex-wrap gap-2 mb-8">
                <button
                  type="button"
                  aria-pressed={selectedColor === null}
                  onClick={() => setSelectedColor(null)}
                  className={`px-3 py-1.5 rounded-md border text-sm focus-visible:ring-2 focus-visible:ring-blue-400 ${selectedColor === null ? "border-blue-500 text-white bg-slate-800" : "border-slate-700 text-slate-400"}`}
                >
                  Catalog hero
                </button>
                {selectedStyle.colors.map((color) => {
                  const hasFailed = failedImages.has(color.imageUrl);
                  return (
                    <button
                      type="button"
                      key={color.name}
                      aria-pressed={selectedColor === color.name}
                      onClick={() => setSelectedColor(color.name)}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md border transition-all focus-visible:ring-2 focus-visible:ring-blue-400 ${
                        selectedColor === color.name
                          ? "bg-slate-800 border-blue-500 text-white shadow-sm"
                          : "bg-slate-900 border-slate-800 text-slate-400 hover:bg-slate-800/80 hover:text-slate-200"
                      }`}
                    >
                      <div className="w-9 h-7 rounded-sm bg-white overflow-hidden flex-shrink-0 relative border border-slate-600 flex items-center justify-center">
                        {color.imageUrl && !hasFailed ? (
                          <img 
                            src={color.imageUrl} 
                            alt={color.name} 
                            className="w-full h-full object-cover absolute inset-0 z-10" 
                            onError={() => handleImageError(color.imageUrl)}
                          />
                        ) : null}
                      </div>
                      <span className="text-sm font-medium">{color.name}</span>
                    </button>
                  );
                })}
              </div>

              <div className="flex flex-col md:flex-row gap-6">
                <div className="w-full md:w-1/2">
                  <div className="aspect-square bg-slate-800/30 rounded-xl border border-slate-800 overflow-hidden relative flex items-center justify-center p-4">
                    {(() => {
                      const colorObj = selectedStyle.colors.find(c => c.name === selectedColor);
                      const imageUrl = colorObj?.imageUrl || selectedStyle.heroImageUrl;
                      
                      if (imageUrl && !failedImages.has(imageUrl)) {
                        return (
                          <img 
                            src={imageUrl} 
                            alt={selectedColor || selectedStyle.style} 
                             className="max-w-full max-h-full object-contain relative z-10"
                            onError={() => handleImageError(imageUrl)}
                          />
                        );
                      }
                      
                      return (
                        <div className="text-center text-slate-500 flex flex-col items-center absolute z-0">
                          <ImageIcon className="w-12 h-12 mb-3 opacity-50" />
                          <p className="text-sm font-medium">Image unavailable</p>
                        </div>
                      );
                    })()}
                  </div>
                  
                  <p className="mt-3 text-sm font-medium text-slate-300 text-center" aria-live="polite">{selectedColor ?? "Catalog hero — sample decoration"}</p>
                  {selectedStyle.imageNote && (
                    <div className="mt-3 text-xs text-slate-500 italic text-center">
                      * {selectedStyle.imageNote}
                    </div>
                  )}
                  <p className="mt-2 text-xs text-slate-500 text-center">Extracted catalog thumbnails may appear soft when enlarged. Photos remain Cap America's.</p>
                </div>

                <div className="w-full md:w-1/2 flex flex-col">
                  {selectedStyle.pageImageUrl && (
                    <div className="flex-1 bg-slate-800/30 rounded-xl border border-slate-800 p-4 flex flex-col">
                      <div className="flex justify-between items-center mb-3">
                         <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Catalog Page {selectedStyle.catalogPage}</h4>
                         <Button
                           variant="ghost"
                           size="sm"
                           className="h-7 text-xs text-slate-400 hover:text-white"
                           onClick={() => setShowCatalogPage(!showCatalogPage)}
                         >
                           {showCatalogPage ? 'Hide Page' : 'View Page'}
                         </Button>
                      </div>
                      
                      {showCatalogPage ? (
                        <div className="flex-1 relative rounded-lg overflow-hidden border border-slate-700 bg-slate-950 min-h-[300px] flex items-center justify-center">
                           {!failedImages.has(selectedStyle.pageImageUrl) ? (
                             <img 
                               src={selectedStyle.pageImageUrl} 
                               alt={`Catalog Page ${selectedStyle.catalogPage}`}
                               className="w-full h-full object-contain absolute inset-0 z-10"
                               onError={() => handleImageError(selectedStyle.pageImageUrl)}
                             />
                           ) : (
                             <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500 bg-slate-900 z-0">
                               <AlertTriangle className="w-8 h-8 mb-2" />
                               <span className="text-sm">Page scan unavailable</span>
                             </div>
                           )}
                        </div>
                      ) : (
                        <div className="flex-1 flex flex-col items-center justify-center text-slate-500 min-h-[300px] border border-dashed border-slate-700 rounded-lg">
                           <ImageIcon className="w-8 h-8 mb-2 opacity-50" />
                           <span className="text-sm">Original catalog scan available</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
