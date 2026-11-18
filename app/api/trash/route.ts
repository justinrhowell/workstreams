import { trashAction, trashData } from "@/lib/ws/server"
import { json, writeJson } from "@/lib/ws/route-helpers"

export const dynamic = "force-dynamic"
export const GET = () => json(trashData)
export const POST = (req: Request) => writeJson(req, trashAction)
