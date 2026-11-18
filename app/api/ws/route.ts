import { boardData } from "@/lib/ws/server"
import { readJson } from "@/lib/ws/route-helpers"

export const dynamic = "force-dynamic"
export const GET = (req: Request) => readJson(req, boardData)
