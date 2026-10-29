import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../middlewares/requireStaff";
import { automationData, saveSettings } from "../lib/printscope/automationStore";
import { queueScan } from "../lib/printscope/automationIntake";
import { actionPreview, approveActions } from "../lib/printscope/automationActions";
import { environment } from "../lib/printscope/worker";
const router=Router();
const approval=z.object({token:z.string().regex(/^[a-f0-9]{64}$/),decision:z.enum(["pass","fail","email"]),confirmComplete:z.boolean(),note:z.string().max(2000),testMode:z.boolean().optional(),selectedFileIds:z.array(z.string().regex(/^\d+$/)).max(2000).optional()}).strict();
router.use("/printscope/automation",(req,res,next)=>{if(!req.staff){res.status(401).json({error:"Staff session required"});return;}next();});
router.get("/printscope/automation",async(_req,res)=>{res.json(await automationData());});
router.put("/printscope/automation",requireAdmin,async(req,res)=>{
  try {await saveSettings(req.body,req.staff!.id);res.json(await automationData());}
  catch(e:any){res.status(e instanceof z.ZodError?400:409).json({error:e.message});}
});
router.post("/printscope/automation/scan",requireAdmin,async(req,res)=>{
  try{res.status(202).json(await queueScan(req.staff!.id));}catch(e:any){res.status(409).json({error:e.message});}
});
router.post("/printscope/automation/invoices/:orderId/preview",async(req,res)=>{
  if(!/^\d+$/.test(req.params.orderId)){res.status(400).json({error:"Invalid invoice"});return;}
  try{res.json(await actionPreview(req.params.orderId));}catch(e:any){res.status(409).json({error:e.message});}
});
router.post("/printscope/automation/invoices/:orderId/approve",async(req,res)=>{
  if(environment!=="production" && req.staff?.role!=="admin"){res.status(403).json({error:"Only administrators may execute restricted live tests."});return;}
  if(!/^\d+$/.test(req.params.orderId)){res.status(400).json({error:"Invalid invoice"});return;}
  const input=approval.safeParse(req.body);
  if(!input.success){res.status(400).json({error:"Invalid approval"});return;}
  try{res.json(await approveActions(req.params.orderId,input.data,req.staff!.id));}catch(e:any){res.status(409).json({error:e.message});}
});
export default router;
