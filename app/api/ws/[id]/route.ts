import { detailData, workstreamAction } from "@/lib/ws/server"
import { json, writeJson } from "@/lib/ws/route-helpers"

export const dynamic = "force-dynamic"
type Ctx = { params: { id: string } }

export const GET = (_req: Request, { params }: Ctx) => json(() => detailData(params.id))
export const POST = (req: Request, { params }: Ctx) => writeJson(req, (body) => workstreamAction(params.id, body))
