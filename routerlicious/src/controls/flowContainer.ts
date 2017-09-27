import * as api from "../api";
import * as ui from "../ui";
import { Status } from "./status";

export class FlowContainer extends ui.Component {
    public status: Status;
    public content: ui.Component;

    constructor(element: HTMLDivElement) {
        super(element);
        const statusDiv = document.createElement("div");
        statusDiv.style.borderTop = "1px solid gray";
        this.status = new Status(statusDiv);
        element.appendChild(statusDiv);
    }

    public trackInsights(insights: api.IMap) {
        this.updateInsights(insights);
        insights.on("valueChanged", () => {
            this.updateInsights(insights);
        });
    }

    public addContent(content: ui.Component) {
        this.content = content;
        this.addChild(content);
        document.body.appendChild(content.element);
        this.resizeCore(this.size);
    }

    protected resizeCore(bounds: ui.Rectangle) {
        let vertSplit = bounds.nipVertBottom(22);

        if (this.content) {
            vertSplit[0].conformElement(this.content.element);
            this.content.resize(vertSplit[0]);
        }

        vertSplit[1].y++; vertSplit[1].height--; // room for 1px border
        vertSplit[1].conformElement(this.status.element);
        this.status.resize(vertSplit[1]);
    }

    private async updateInsights(insights: api.IMap) {
        const view = await insights.getView();
        if (view.has("ResumeAnalytics")) {
            const resume = view.get("ResumeAnalytics");
            const probability = parseFloat(resume.resumeAnalyticsResult);
            if (probability !== 1 && probability > 0.7) {
                this.status.overlay(`${Math.round(probability * 100)}% sure I found a resume!`);
            }
        }
        if (view.has("TextAnalytics")) {
            const analytics = view.get("TextAnalytics");
            if (analytics.language) {
                this.status.add("li", analytics.language);
            }
            if (analytics.sentiment) {
                const sentimentEmoji = analytics.sentiment > 0.7
                    ? "🙂"
                    : analytics.sentiment < 0.3 ? "🙁" : "😐";
                this.status.add("si", sentimentEmoji);
            }
        }
    }
}
