import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: '利用規約・免責事項 — 聴き宮',
};

function Article({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm tracking-[0.2em] text-gold">{title}</h2>
      <div className="space-y-3 text-sm leading-loose text-paper-dim">{children}</div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <header className="space-y-3 text-center">
        <p className="text-xs tracking-[0.35em] text-paper-dim">おやくそく</p>
        <h1 className="text-xl tracking-[0.2em] sm:text-2xl">利用規約・免責事項</h1>
        <p className="text-xs text-paper-dim">
          公開前に運営者ご自身で内容を確認・修正してください。
        </p>
      </header>

      <div className="rule" />

      <Article title="第1条 これは何か">
        <p>
          聴き宮は、匿名の来訪者と運営者（以下「神父」）が一対一で話すための場所です。
          神父は、話を聴くことだけを行います。
        </p>
        <p>
          <span className="text-paper">
            本サービスはカウンセリング・心理療法・医療行為のいずれでもありません。
          </span>
          神父は医師・臨床心理士・公認心理師その他の専門資格に基づく支援を提供する者ではなく、
          診断・治療・専門的助言は一切行いません。
        </p>
      </Article>

      <Article title="第2条 緊急のとき">
        <p>
          いのちに関わる状況、犯罪や虐待に関わる状況では、本サービスではなく
          公的・専門的な窓口をご利用ください。神父は通報や救助を行える立場にありません。
          連絡先は
          <Link href="/help" className="link mx-1">
            相談窓口
          </Link>
          にまとめてあります。
        </p>
      </Article>

      <Article title="第3条 匿名性と記録">
        <p>会員登録・ログイン・氏名の入力はありません。</p>
        <p>
          <span className="text-paper">音声と、告解室で交わした文字の内容は保存しません。</span>
          文字のやりとりは、その対話が続いている間だけサーバーのメモリ上に置かれ
          （再読み込みで戻れるようにするためです）、対話の終了と同時に破棄されます。
        </p>
        <p>
          例外は「文章で預ける」機能です。この手紙と返事だけは、返事をお返しするために
          サーバーに保存されます。投稿時に発行されるURLが、その手紙にアクセスする唯一の鍵です。
          運営者は、この保存された手紙をいつでも削除できます。
        </p>
        <p>
          手紙には、<span className="text-paper">お名前・メールアドレス・性別・年代を任意で</span>
          添えられます。<span className="text-paper">すべて空欄のままで送れます。</span>
          書いていただいた場合は、その内容も手紙と一緒に保存され、神父だけが見ます。
          第三者に渡したり、広告や分析に使ったりすることはありません。
          手紙を削除すると、添えられた情報も一緒に消えます。
        </p>
        <p>IPアドレス等の識別情報は、記録・追跡の目的では保持しません。</p>
      </Article>

      <Article title="第4条 一度にひとり">
        <p>
          神父が同時に対応できるのは1名です。先客がいる場合は待機列に入っていただきます。
          待機中にページを閉じると列から外れます。順番が来てから一定時間応答がない場合、
          次の方にお譲りいただきます。
        </p>
        <p>
          在室確認のため、ブラウザは数秒おきにサーバーへ信号を送ります。
          ブラウザを閉じる・再読み込みして戻らない場合、一定時間で自動的に退室扱いになります。
        </p>
      </Article>

      <Article title="第5条 お布施">
        <p>
          お布施は任意です。金額はご自由にお決めいただけます。
          納めても納めなくても、話す時間や対応が変わることはありません。
        </p>
        <p>
          決済は Stripe を通じて行われます。カード情報が聴き宮のサーバーを通ることはありません。
          サービスの性質上、お布施の返金には応じられません。
        </p>
      </Article>

      <Article title="第6条 お願い">
        <p>次の行為はご遠慮ください。神父の判断で退室していただくことがあります。</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>他者への脅迫、差別的な言動、執拗な攻撃行為</li>
          <li>会話の録音・録画・転載、および第三者への公開</li>
          <li>営業・勧誘・宗教や政治への勧誘</li>
          <li>他の方の待機を妨げる行為</li>
        </ul>
      </Article>

      <Article title="第7条 免責">
        <p>
          神父の応答は個人の感想にすぎず、その内容の正確性・有用性について保証しません。
          本サービスの利用または利用できなかったことにより生じたいかなる損害についても、
          運営者は責任を負いません。
        </p>
        <p>
          通信環境やサーバーの都合により、予告なくサービスを中断・終了することがあります。
        </p>
      </Article>

      <Article title="第8条 変更">
        <p>
          本規約は予告なく変更されることがあります。変更後にご利用いただいた時点で、
          変更後の内容に同意いただいたものとみなします。
        </p>
      </Article>

      <div className="rule" />

      <div className="flex flex-col gap-3 sm:flex-row">
        <Link href="/" className="btn btn-quiet grow">
          入口へ戻る
        </Link>
        <Link href="/message" className="btn btn-quiet">
          文章で預ける
        </Link>
      </div>
    </div>
  );
}
