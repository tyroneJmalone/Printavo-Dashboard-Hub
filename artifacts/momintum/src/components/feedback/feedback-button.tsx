import { useState } from "react";
import { MessageSquarePlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

const BASE = "";

const TYPE_LABELS: Record<string, { label: string; emoji: string }> = {
  bug: { label: "Bug report", emoji: "🐛" },
  feature: { label: "Feature request", emoji: "✨" },
  idea: { label: "Idea", emoji: "💡" },
  general: { label: "General feedback", emoji: "💬" },
};

export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState("general");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const reset = () => {
    setType("general");
    setTitle("");
    setBody("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/momintum/feedback`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, title: title.trim(), body: body.trim() }),
      });
      if (!res.ok) throw new Error("Failed to submit");
      toast({ title: "Feedback sent!", description: "Your message was sent to the admin. Thanks!" });
      setOpen(false);
      reset();
    } catch {
      toast({ title: "Error", description: "Couldn't send feedback. Please try again.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full bg-primary text-primary-foreground shadow-lg px-4 py-2.5 text-sm font-medium hover:bg-primary/90 transition-all hover:shadow-xl active:scale-95"
        aria-label="Send feedback"
      >
        <MessageSquarePlus className="w-4 h-4" />
        <span>Feedback</span>
      </button>

      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Share feedback</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground -mt-2">
            Found a bug? Have an idea? Want a new feature? Let the admin know — they'll see this right away.
          </p>
          <form onSubmit={handleSubmit} className="space-y-4 pt-1">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Type</label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TYPE_LABELS).map(([val, { label, emoji }]) => (
                    <SelectItem key={val} value={val}>
                      {emoji} {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Title</label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Short summary…"
                required
                maxLength={120}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Details</label>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Describe what you saw, what you expected, or what you'd like…"
                required
                rows={4}
                className="resize-none"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" onClick={() => { setOpen(false); reset(); }}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading || !title.trim() || !body.trim()}>
                {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Send feedback
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
