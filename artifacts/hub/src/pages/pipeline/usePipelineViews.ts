import { 
  useListPipelineViews, 
  useCreatePipelineView, 
  useUpdatePipelineView, 
  useDeletePipelineView,
  getListPipelineViewsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import type { PipelineViewConfig } from "@workspace/api-client-react";

export function usePipelineViews(userEmail: string) {
  const getViewsKey = () => [...getListPipelineViewsQueryKey(), userEmail];

  const { data: views = [], isSuccess: viewsLoaded, isError: viewsError, refetch: refetchViews } = useListPipelineViews({
    query: {
      queryKey: getViewsKey()
    }
  });

  const createView = useCreatePipelineView();
  const updateView = useUpdatePipelineView();
  const deleteView = useDeletePipelineView();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isMutating = updateView.isPending || createView.isPending || deleteView.isPending;

  const stripEmpties = (c: PipelineViewConfig): PipelineViewConfig => {
    const obj = { ...c };
    if (!obj.q) delete obj.q;
    if (!obj.createdFrom) delete obj.createdFrom;
    if (!obj.createdTo) delete obj.createdTo;
    if (!obj.invoiceFrom) delete obj.invoiceFrom;
    if (!obj.invoiceTo) delete obj.invoiceTo;
    if (!obj.productionDueFrom) delete obj.productionDueFrom;
    if (!obj.productionDueTo) delete obj.productionDueTo;
    if (!obj.customerDueFrom) delete obj.customerDueFrom;
    if (!obj.customerDueTo) delete obj.customerDueTo;
    return obj;
  };

  const saveView = async (id: string, config: PipelineViewConfig) => {
    try {
      await updateView.mutateAsync({ id, data: { config: stripEmpties(config) } });
      toast({ title: "View updated" });
      queryClient.invalidateQueries({ queryKey: getViewsKey() });
      return true;
    } catch (err) {
      toast({ title: "Failed to update view", variant: "destructive" });
      return false;
    }
  };

  const createNewView = async (name: string, config: PipelineViewConfig) => {
    try {
      const res = await createView.mutateAsync({ data: { name, config: stripEmpties(config) } });
      toast({ title: "View created" });
      queryClient.invalidateQueries({ queryKey: getViewsKey() });
      return res;
    } catch (err) {
      toast({ title: "Failed to create view", variant: "destructive" });
      return null;
    }
  };

  const toggleDefault = async (id: string, currentIsDefault: boolean) => {
    try {
      await updateView.mutateAsync({ id, data: { isDefault: !currentIsDefault } });
      toast({ title: currentIsDefault ? "Default removed" : "Set as default" });
      queryClient.invalidateQueries({ queryKey: getViewsKey() });
      return true;
    } catch (err) {
      toast({ title: "Failed to update default status", variant: "destructive" });
      return false;
    }
  };

  const renameView = async (id: string, name: string) => {
    try {
      await updateView.mutateAsync({ id, data: { name } });
      toast({ title: "View renamed" });
      queryClient.invalidateQueries({ queryKey: getViewsKey() });
      return true;
    } catch (err) {
      toast({ title: "Failed to rename view", variant: "destructive" });
      return false;
    }
  };

  const deleteViewById = async (id: string) => {
    try {
      await deleteView.mutateAsync({ id });
      toast({ title: "View deleted" });
      queryClient.invalidateQueries({ queryKey: getViewsKey() });
      return true;
    } catch (err) {
      toast({ title: "Failed to delete view", variant: "destructive" });
      return false;
    }
  };

  return {
    views,
    viewsLoaded,
    viewsError,
    refetchViews,
    isMutating,
    saveView,
    createNewView,
    toggleDefault,
    renameView,
    deleteViewById,
  };
}
