import { Client } from '@notionhq/client'
import Parser from 'rss-parser'
import { markdownToBlocks } from '@tryfabric/martian'
import 'dotenv/config'
import { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints'

const notion = new Client({
    auth: process.env.NOTION_TOKEN
})

let parser = new Parser()

const genReport = async () => {
    let today = new Date()
    let yesterday = new Date(today.getDate() - 1)
    let report_md = `# Daily Report - ${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}\n\n`
    if (!process.env.NOTION_RSS_DATABASE_ID) 
        throw new Error('RSS_DATABASE_ID is not set')

    let pages = await notion.databases.query({
        database_id: process.env.NOTION_RSS_DATABASE_ID,
    })

    let rss_sources = pages.results.map((page: any) => {
        if ("properties" in page && (page.properties.Enabled as any).checkbox) {
            return {
                name: (page.properties.Name as any).title[0].text.content,
                url: (page.properties.Link as any).url
            }
        }
    }).filter((elem: any) => elem != undefined)

    for (let i=0; i<rss_sources.length; i++) {
        let feed = await parser.parseURL(rss_sources[i]!.url)
        let items = feed.items.filter((item: any) => {
            if (item.pubDate) {
                let pubDate = new Date(item.pubDate)
                return pubDate.getDay() == yesterday.getDay()
            }
            
            return false
        }).slice(0, 3)
        report_md += "## " + rss_sources[i]!.name + " (" + items.length +")" + "\n\n"
        items.forEach((item: any) => {
            report_md += "### " + item.title + "\n" + item.contentSnippet + "\n\n"
        })
    }

    report_md += "Have a nice day!"
    if (!process.env.NOTION_DAILY_UPDATE_DATABASE_ID) 
        throw new Error('NOTION_DAILY_UPDATE_DATABASE_ID is not set')
    let res = await notion.pages.create({
        parent: {
            database_id: process.env.NOTION_DAILY_UPDATE_DATABASE_ID
        },
        properties: {
            'Name': {
                type: 'title',
                title: [
                    {
                      type: 'text',
                      text: {
                        content: `Daily Report - ${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`,
                      },
                    },
                ],
            },
            'Date': {
                type: 'date',
                date: {
                    start: today.toISOString(),
                },
            }
        },
        children: markdownToBlocks(report_md) as BlockObjectRequest[],
    })

    console.log("Success, ", res.id)
}

const main = async () => {
    try {
        await genReport()
    } catch (error) {
        console.error(error)
    }
}

main()