import { detailData, workstreamAction } from "@/lib/ws/server"
import { readJson, writeJson } from "@/lib/ws/route-helpers"

export const dynamic = "force-dynamic"
type Ctx = { params: Promise<{ id: string }> }

export const GET = async (req: Request, { params }: Ctx) => {
  const { id } = await params
  return readJson(req, () => detailData(id))
}
export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params
  return writeJson(req, (body) => workstreamAction(id, body))
}
